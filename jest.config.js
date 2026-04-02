/** @type {import('jest').Config} */
module.exports = {
  // 使用 ts-jest 预设支持 TypeScript
  preset: 'ts-jest',
  
  // 测试环境
  testEnvironment: 'node',
  
  // 测试文件匹配模式
  testMatch: [
    '**/test/**/*.test.js',
    '**/test/**/*.test.ts',
    '**/__tests__/**/*.test.js',
    '**/__tests__/**/*.test.ts'
  ],
  
  // 模块路径映射（对齐 tsconfig.json）
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  
  // 覆盖率收集配置
  collectCoverageFrom: [
    'src/**/*.{js,ts}',
    '!src/**/*.d.ts',
    '!src/index.ts',
    '!src/public/**',
    '!src/database/migrations/**',
    '!src/entities/**',
    '!src/dto/**',
    '!src/legacy189/**' // 已废弃模块不计入覆盖率
  ],
  
  // 覆盖率阈值（P1-03 要求）
  coverageThreshold: {
    global: {
      statements: 70,
      branches: 65,
      functions: 70,
      lines: 70
    },
    // 核心模块更高阈值
    './src/services/cloud139TaskProcessor.js': {
      statements: 80,
      branches: 75,
      functions: 80,
      lines: 80
    },
    './src/services/cloud139.js': {
      statements: 85,
      branches: 80,
      functions: 85,
      lines: 85
    },
    './src/services/task.js': {
      statements: 75,
      branches: 70,
      functions: 75,
      lines: 75
    }
  },
  
  // 覆盖率报告格式
  coverageReporters: [
    'text',        // 终端输出
    'text-summary', // 简要摘要
    'html',        // HTML 报告（本地查看）
    'lcov',        // 用于 CI 集成
    'json-summary' // JSON 格式（可编程读取）
  ],
  
  // 覆盖率输出目录
  coverageDirectory: 'coverage',
  
  // 测试超时（云盘操作可能较慢）
  testTimeout: 30000,
  
  // 全局设置文件
  setupFilesAfterEnv: ['<rootDir>/test/setup.js'],
  
  // 忽略的文件
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/data/',
    '/.git/'
  ],
  
  // TypeScript 转换配置
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        module: 'commonjs',
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        strict: false // 测试中放宽类型检查
      }
    }]
  },
  
  // 详细输出
  verbose: true,
  
  // 显示单个测试文件的覆盖率
  collectCoverage: false, // 默认关闭，通过 --coverage 开启
  
  // 最大并发工作进程数
  maxWorkers: '50%'
};
