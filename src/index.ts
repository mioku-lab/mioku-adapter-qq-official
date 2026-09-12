export { qqOfficialAdapterDefinition } from './adapter'
export * from './bot'
export * from './client'
export * from './config'
export * from './events'
export * from './gateway'
export * from './media'
export * from './passive'
export * from './payload'
export * from './segments'
export * from './store'
export * from './token'

export { qqOfficialAdapterDefinition as default } from './adapter'

declare module 'mioku' {
  interface AdapterBotMap {
    'qq-official': import('./bot').QQOfficialBot
  }
}
