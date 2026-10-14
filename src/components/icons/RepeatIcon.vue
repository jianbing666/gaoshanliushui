<script setup lang="ts">
defineProps<{ size?: number | string }>()
</script>

<template>
  <svg
    :width="size || 18"
    :height="size || 18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M17 2.1l4 4-4 4" />
    <path d="M3 11.5V6a2 2 0 0 1 2-2h11.5" />
    <path d="M7 21.9l-4-4 4-4" />
    <path d="M21 12.5V18a2 2 0 0 1-2 2H7.5" />
  </svg>
</template>
