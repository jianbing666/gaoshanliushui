<script setup lang="ts">
defineProps<{
  size?: number | string
}>()
</script>

<template>
  <svg
    :width="size || 20"
    :height="size || 20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" />
  </svg>
</template>
