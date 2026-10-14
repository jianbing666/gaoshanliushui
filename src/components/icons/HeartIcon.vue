<script setup lang="ts">
defineProps<{
  size?: number | string
  /** 已喜爱时填充实心, 未喜爱时只描边 */
  filled?: boolean
}>()
</script>

<template>
  <svg
    :width="size || 16"
    :height="size || 16"
    viewBox="0 0 24 24"
    :fill="filled ? 'currentColor' : 'none'"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path
      d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l8.84 8.84 8.84-8.84a5.5 5.5 0 0 0 0-7.78z"
    />
  </svg>
</template>
