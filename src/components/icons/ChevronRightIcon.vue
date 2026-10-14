<script setup lang="ts">
defineProps<{ size?: number | string }>()
</script>

<template>
  <svg
    :width="size || 16"
    :height="size || 16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <polyline points="9 18 15 12 9 6" />
  </svg>
</template>
