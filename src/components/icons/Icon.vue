<script setup lang="ts">
import { computed } from 'vue'
import { ICONS, type IconName } from './iconPaths'

/**
 * 统一图标组件(P2)
 * 30 个静态 SVG 图标共用这一份渲染逻辑, 避免每个图标都带一份组件样板。
 * 其余属性(class / style / 事件)由 Vue 自动透传到根节点 svg 上。
 */
const props = defineProps<{
  name: IconName
  /** 覆盖默认尺寸(px) */
  size?: number | string
}>()

const definition = computed(() => ICONS[props.name])
const dimension = computed(() => props.size || definition.value.size)
</script>

<template>
  <svg
    :width="dimension"
    :height="dimension"
    :viewBox="definition.viewBox"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    v-html="definition.html"
  />
</template>
