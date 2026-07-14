declare module 'vue-virtual-scroller' {
  import type { DefineComponent } from 'vue'
  // RecycleScroller: 固定行高虚拟列表
  export const RecycleScroller: DefineComponent<{
    items: any[]
    itemSize?: number | null
    keyField?: string
    direction?: 'vertical' | 'horizontal'
    buffer?: number
    pageMode?: boolean
  }>

  // DynamicScroller: 动态行高虚拟列表
  export const DynamicScroller: DefineComponent<{
    items: any[]
    keyField?: string
    direction?: 'vertical' | 'horizontal'
    buffer?: number
  }>

  export const DynamicScrollerItem: DefineComponent<{
    dataDependencies?: any[]
    sizeDependencies?: any[]
  }>

  // 插件形式：app.use(VueVirtualScroller)
  const plugin: {
    install: (app: any) => void
  }
  export default plugin
}
