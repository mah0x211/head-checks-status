/*
 * MIT License
 *
 * Copyright (c) 2026 Masatoshi Fukunaga
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { appendFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { GitHub } from './github.js';
import { headChecksStatus } from './status.js';

function required(env, key) {
  if (!env[key]) throw new Error('Missing ' + key);
  return env[key];
}

export async function runAction({
  env = process.env, read = readFile, append = appendFile, fetchImpl = fetch,
} = {}) {
  const event = JSON.parse(await read(required(env, 'GITHUB_EVENT_PATH'), 'utf8'));
  const sha = event.pull_request
    ? required(event.pull_request.head ?? {}, 'sha')
    : required(env, 'GITHUB_SHA');
  const outputPath = required(env, 'GITHUB_OUTPUT');
  const api = new GitHub({
    token: env.INPUT_TOKEN || required(env, 'GITHUB_TOKEN'),
    apiUrl: env.GITHUB_API_URL,
    fetchImpl,
  });
  const outputs = await headChecksStatus(api, {
    repository: required(env, 'GITHUB_REPOSITORY'),
    runId: required(env, 'GITHUB_RUN_ID'),
    sha,
  });
  const commands = Object.entries(outputs).map(([name, value]) => {
    let delimiter;
    do { delimiter = 'output_' + randomUUID(); } while (value.includes(delimiter));
    return name + '<<' + delimiter + '\n' + value + '\n' + delimiter + '\n';
  }).join('');
  await append(outputPath, commands, 'utf8');
  return outputs;
}
