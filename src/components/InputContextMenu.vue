<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { writeText, readText } from '@tauri-apps/plugin-clipboard-manager'

const menuRef = ref<HTMLDivElement | null>(null)
const visible = ref(false)
const position = ref({ x: 0, y: 0 })
const targetInput = ref<HTMLInputElement | HTMLTextAreaElement | null>(null)

function handleContextMenu(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
    e.preventDefault()
    e.stopPropagation()

    targetInput.value = target as HTMLInputElement | HTMLTextAreaElement
    position.value = { x: e.clientX, y: e.clientY }
    visible.value = true

    nextTick(() => {
      if (!menuRef.value) return
      const menu = menuRef.value
      const rect = menu.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight

      if (position.value.x + rect.width > viewportWidth) {
        position.value.x = viewportWidth - rect.width - 8
      }
      if (position.value.y + rect.height > viewportHeight) {
        position.value.y = viewportHeight - rect.height - 8
      }
    })
  }
}

function closeMenu() {
  visible.value = false
  targetInput.value = null
}

function handleClickOutside(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    closeMenu()
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    closeMenu()
  }
}

async function handleCut() {
  if (!targetInput.value) return
  const input = targetInput.value
  const start = input.selectionStart ?? 0
  const end = input.selectionEnd ?? 0
  const selected = input.value.substring(start, end)
  if (selected) {
    await writeText(selected)
    const newValue = input.value.substring(0, start) + input.value.substring(end)
    input.value = newValue
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  closeMenu()
}

async function handleCopy() {
  if (!targetInput.value) return
  const input = targetInput.value
  const start = input.selectionStart ?? 0
  const end = input.selectionEnd ?? 0
  const selected = input.value.substring(start, end)
  if (selected) {
    await writeText(selected)
  }
  closeMenu()
}

async function handlePaste() {
  if (!targetInput.value) return
  const input = targetInput.value
  const text = await readText()
  if (text) {
    const start = input.selectionStart ?? 0
    const end = input.selectionEnd ?? 0
    const newValue = input.value.substring(0, start) + text + input.value.substring(end)
    input.value = newValue
    input.selectionStart = input.selectionEnd = start + text.length
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.focus()
  }
  closeMenu()
}

function handleDelete() {
  if (!targetInput.value) return
  const input = targetInput.value
  const start = input.selectionStart ?? 0
  const end = input.selectionEnd ?? 0
  if (start !== end) {
    const newValue = input.value.substring(0, start) + input.value.substring(end)
    input.value = newValue
    input.selectionStart = input.selectionEnd = start
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  closeMenu()
}

function handleClear() {
  if (!targetInput.value) return
  const input = targetInput.value
  input.value = ''
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.focus()
  closeMenu()
}

function handleSelectAll() {
  if (!targetInput.value) return
  const input = targetInput.value
  input.select()
  closeMenu()
}

onMounted(() => {
  document.addEventListener('contextmenu', handleContextMenu, true)
  document.addEventListener('mousedown', handleClickOutside, true)
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('contextmenu', handleContextMenu, true)
  document.removeEventListener('mousedown', handleClickOutside, true)
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="menuRef"
      class="fixed z-[9999] bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 py-1 min-w-[140px]"
      :style="{ left: position.x + 'px', top: position.y + 'px' }"
      @contextmenu.prevent
    >
      <button
        class="w-full px-3 py-1.5 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50 flex items-center gap-2"
        @click="handleCut"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z"
          />
        </svg>
        剪切
      </button>
      <button
        class="w-full px-3 py-1.5 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50 flex items-center gap-2"
        @click="handleCopy"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
          />
        </svg>
        复制
      </button>
      <button
        class="w-full px-3 py-1.5 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50 flex items-center gap-2"
        @click="handlePaste"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
          />
        </svg>
        粘贴
      </button>
      <button
        class="w-full px-3 py-1.5 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50 flex items-center gap-2"
        @click="handleDelete"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
          />
        </svg>
        删除
      </button>
      <div class="border-t border-gray-200 dark:border-gray-700 my-1"></div>
      <button
        class="w-full px-3 py-1.5 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50 flex items-center gap-2"
        @click="handleSelectAll"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M4 6h16M4 10h16M4 14h16M4 18h16"
          />
        </svg>
        全选
      </button>
      <button
        class="w-full px-3 py-1.5 text-left text-sm text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2"
        @click="handleClear"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
        清除
      </button>
    </div>
  </Teleport>
</template>
