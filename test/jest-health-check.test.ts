/**
 * Jest 配置健康检查测试
 * 
 * 验证 Jest 环境正确配置
 */

describe('Jest Configuration Health Check', () => {
  test('Jest is properly configured', () => {
    expect(true).toBe(true);
  });

  test('Node environment is set to test', () => {
    expect(process.env.NODE_ENV).toBe('test');
  });

  test('TypeScript support is working', () => {
    const tsValue: string = 'TypeScript works';
    expect(tsValue).toBe('TypeScript works');
  });

  test('Async/await support', async () => {
    const promise = Promise.resolve('async works');
    await expect(promise).resolves.toBe('async works');
  });

  test('Mock functions work', () => {
    const mockFn = jest.fn(() => 'mocked');
    expect(mockFn()).toBe('mocked');
    expect(mockFn).toHaveBeenCalledTimes(1);
  });
});
