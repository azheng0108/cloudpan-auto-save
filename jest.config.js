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
    'src/services/checkpointManager.js',
    'src/services/errorClassifier.js',
    'src/services/taskErrorService.js',
    'src/services/taskNamingService.js',
    'src/services/taskParserService.js'
  ],
  
  // 覆盖率阈值（P1-03 要求）
  coverageThreshold: {
    global: {
      statements: 70,
      branches: 58,
      functions: 70,
      lines: 70
    },
    './src/services/checkpointManager.js': {
      statements: 85,
      branches: 80,
      functions: 90,
      lines: 85
    },
    './src/services/errorClassifier.js': {
      statements: 75,
      branches: 65,
      functions: 90,
      lines: 80
    },
    './src/services/taskErrorService.js': {
      statements: 50,
      branches: 40,
      functions: 60,
      lines: 50
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
