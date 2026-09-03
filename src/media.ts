import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import type { Logger } from 'mioku'
import type { QQClient } from './client'

export type MediaFileType = 1 | 2 | 3 | 4

export interface UploadTarget {
  type: 'group' | 'user'
  id: string
}

const CACHE_TTL_MS = 240_000

const hashSource = (file: string | Buffer): string =>
  createHash('md5').update(file).digest('hex')

/** file 支持公网 URL / 本地路径 / file:// / base64:// / Buffer;URL 直接上传,其余转裸 base64 */
const toUploadField = async (
  file: string | Buffer,
): Promise<{ url?: string; fileData?: string }> => {
  if (Buffer.isBuffer(file)) {
    return { fileData: file.toString('base64') }
  }
  if (/^https?:\/\//i.test(file)) return { url: file }
  if (file.startsWith('base64://')) return { fileData: file.slice('base64://'.length) }
  if (file.startsWith('data:')) {
    const index = file.indexOf(',')
    return index >= 0 ? { fileData: file.slice(index + 1) } : { fileData: file }
  }
  const path = file.startsWith('file://') ? file.slice('file://'.length) : file
  const buffer = await readFile(path.replace(/^\/+/, '/'))
  return { fileData: buffer.toString('base64') }
}

const inferFileType = (file: string | Buffer, fallback: MediaFileType): MediaFileType => {
  if (Buffer.isBuffer(file)) return fallback
  const lower = file.split('?')[0].toLowerCase()
  if (/\.(png|jpe?g|gif|webp|bmp)$/.test(lower)) return 1
  if (lower.endsWith('.mp4')) return 2
  if (/\.(silk|mp3|wav|ogg|amr)$/.test(lower)) return 3
  return fallback
}

/** 富媒体上传:先上传拿 file_info,再随消息发送;file_info 有 TTL,按目标+内容做短时缓存 */
export class MediaUploader {
  private cache = new Map<string, { fileInfo: string; expiresAt: number }>()

  constructor(
    private readonly client: QQClient,
    private readonly logger: Logger,
  ) {}

  async upload(target: UploadTarget, file: string | Buffer, fileType?: MediaFileType): Promise<string> {
    const resolvedType = fileType ?? inferFileType(file, 4)
    const source = await hashSource(file)
    const cacheKey = `${target.type}:${target.id}:${resolvedType}:${source}`
    const cached = this.cache.get(cacheKey)
    if (cached && Date.now() < cached.expiresAt) return cached.fileInfo

    const field = await toUploadField(file)
    const body: Record<string, unknown> = {
      file_type: resolvedType,
      srv_send_msg: false,
    }
    if (field.url) body.url = field.url
    else if (field.fileData) body.file_data = field.fileData
    else throw new Error(`不支持的媒体来源: ${typeof file}`)

    const res = await this.client.post<{ file_info?: string }>(
      `/v2/${target.type}s/${target.id}/files`,
      body,
    )
    if (!res?.file_info) throw new Error('富媒体上传失败:响应缺少 file_info')
    this.cache.set(cacheKey, {
      fileInfo: res.file_info,
      expiresAt: Date.now() + CACHE_TTL_MS,
    })
    this.logger.debug(`媒体上传完成 type=${resolvedType} target=${target.id}`)
    return res.file_info
  }

  clear(): void {
    this.cache.clear()
  }
}
