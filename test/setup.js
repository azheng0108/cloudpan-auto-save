/**
 * Jest 测试全局设置
 * 
 * 在所有测试运行前执行初始化
 */

// 设置环境变量
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error'; // 测试时减少日志输出

// 全局超时设置
jest.setTimeout(30000);

// Mock 云盘 API 的通用设置
global.mockCloud139API = {
  listShare: jest.fn(),
  saveShareFiles: jest.fn(),
  listAllDiskFiles: jest.fn(),
  createFolder: jest.fn()
};

// 清理函数
afterAll(() => {
  // 测试结束后清理资源
  jest.clearAllMocks();
});
