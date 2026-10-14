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
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
    <circle cx="5" cy="12" r="1" />
  </svg>
</template>
