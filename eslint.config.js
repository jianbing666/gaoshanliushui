import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import prettier from 'eslint-config-prettier'

// ESLint 扁平配置
//
// 分工: 类型正确性交给 vue-tsc (npm run typecheck), ESLint 只负责
// 可疑写法与 Vue 模板约束, Prettier 负责格式 —— 三者互不重叠。
export default tseslint.config(
  {
    // .trae/ 是私有草稿与一次性分析脚本 (已在 .gitignore 中排除), 不纳入检查
    ignores: ['dist/**', 'node_modules/**', 'src-tauri/**', '.trae/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  {
    rules: {
      // 未定义标识符由 TypeScript 负责, ESLint 重复检查会误报浏览器全局变量
      'no-undef': 'off',
      // Player / Sidebar 是既有的单名组件, 改名会牵动全部引用, 不为此规则买单
      'vue/multi-word-component-names': 'off',
      // 存量 any 先降级为告警, 按 优化方案.md P1-2 逐步清理
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // 类型声明文件是绑定三方库类型的手写样板, 这里的 any / {} 是有意为之。
    // 必须放在通用规则之后: 扁平配置里后出现的同名规则覆盖先出现的。
    files: ['**/*.d.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  prettier
)
