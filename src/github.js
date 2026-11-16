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

export class GitHub {
  constructor({ token, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
    if (!token) throw new Error('A GitHub token is required');
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.token = token;
    this.fetch = fetchImpl;
  }

  async get(path, query = {}) {
    const url = new URL(this.apiUrl + path);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
    const response = await this.fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + this.token,
        'User-Agent': 'head-checks-status',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    if (!response.ok) {
      throw new Error('GitHub API request failed: HTTP ' + response.status);
    }
    return response.json();
  }

  async list(path, key, query = {}, limit = Infinity) {
    const items = [];
    for (let page = 1; ; page += 1) {
      const data = await this.get(path, { ...query, per_page: 100, page });
      if (!Array.isArray(data[key]) || !Number.isSafeInteger(data.total_count)
          || data.total_count < 0) {
        throw new Error('Invalid paginated GitHub API response');
      }
      // The workflow-run search API returns at most 1,000 matching runs.
      if (data.total_count > limit) {
        throw new Error('GitHub API search limit exceeded; cannot select the latest attempt reliably');
      }
      items.push(...data[key]);
      if (items.length >= data.total_count) return items;
      if (data[key].length === 0) {
        throw new Error('Incomplete paginated GitHub API response');
      }
    }
  }
}
