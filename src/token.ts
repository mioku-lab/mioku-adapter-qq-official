import { TOKEN_URL } from './config'

import type { Driver, Logger } from 'mioku'

export class TokenManager {
  private accessToken: string | undefined
  private expiresAt = 0
  private refreshing: Promise<string> | undefined

  constructor(
    private readonly driver: Driver,
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly logger: Logger,
  ) {}

  async get(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - 120_000) {
      return this.accessToken
    }
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  invalidate(): void {
    this.accessToken = undefined
    this.expiresAt = 0
  }

  private async refresh(): Promise<string> {
    const res = await this.driver.http.request({
      method: 'POST',
      url: TOKEN_URL,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
      timeout: 10_000,
    })
    let data: { access_token?: string; expires_in?: number | string; message?: string }
    try {
      data = JSON.parse(res.text())
    } catch {
      throw new Error(`获取 access_token 失败:非 JSON 响应 ${res.text().slice(0, 200)}`)
    }
    if (!data.access_token) {
      throw new Error(`获取 access_token 失败:${data.message ?? res.text().slice(0, 200)}`)
    }
    this.accessToken = data.access_token
    this.expiresAt = Date.now() + (Number(data.expires_in) || 7200) * 1000
    this.logger.debug(`access_token 已刷新,${Math.round((this.expiresAt - Date.now()) / 1000)}s 后过期`)
    return this.accessToken
  }
}
