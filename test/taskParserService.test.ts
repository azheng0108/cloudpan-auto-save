/**
 * Task Parser Service 测试
 * 迁移自 test-task-parser-service.js
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { TaskParserService } from '../src/services/taskParserService';

describe('TaskParserService', () => {
    let parser: any;

    beforeEach(() => {
        parser = new TaskParserService();
    });

    describe('Cloud139 解析', () => {
        test('应该从文本提取 Cloud139 分享链接', () => {
            const extracted = parser.extractCloud139ShareText(
                '链接: https://yun.139.com/w/r?linkID=abc123 提取码: XY12'
            );
            
            expect(extracted).toBeTruthy();
            expect(extracted.url).toContain('linkID=abc123');
        });

        test('应该解析 Cloud139 分享链接', () => {
            const parsed = parser.parseCloud139ShareLink(
                'https://yun.139.com/w/r?linkID=zy0DDGAkum96&passwd=XD7G'
            );
            
            expect(parsed.linkID).toBe('zy0DDGAkum96');
            expect(parsed.passwd).toBe('XD7G');
        });

        test('应该处理没有密码的链接', () => {
            const parsed = parser.parseCloud139ShareLink(
                'https://yun.139.com/w/r?linkID=testlink'
            );
            
            expect(parsed.linkID).toBe('testlink');
            expect(parsed.passwd).toBeFalsy();
        });

        test('应该构建 Cloud139 分享文件夹结构', async () => {
            const mockCloud139 = {
                async listShareDir(linkID: string, passwd: string, folderId: string) {
                    if (!folderId || folderId === 'root') {
                        return {
                            linkName: '资源A',
                            fileList: [],
                            folderList: [{ catalogID: 'c1', catalogName: 'Season1' }],
                        };
                    }
                    return {
                        fileList: [{ contentID: 'f1' }],
                        folderList: [{ catalogID: 'c2', catalogName: 'Ep' }],
                    };
                },
            };

            const folders = await parser.buildCloud139ShareFolders(
                mockCloud139,
                'https://yun.139.com/w/r?linkID=zy0DDGAkum96',
                ''
            );

            expect(folders.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('Cloud189 解析', () => {
        test('应该解析 Cloud189 分享链接', () => {
            const parsed = parser.parseCloud189ShareInput(
                'https://cloud.189.cn/t/AbCdEf12（访问码：1a2B）'
            );
            
            expect(parsed.normalizedUrl).toContain('/t/AbCdEf12');
            expect(parsed.parsedAccessCode).toBe('1a2B');
            expect(parsed.shareCode).toBe('AbCdEf12');
        });

        test.skip('应该处理不同的访问码格式', () => {
            // TODO: 补充覆盖不同访问码格式的真实断言
        });

        test('应该构建 Cloud189 分享文件夹结构', async () => {
            const mockCloud189 = {
                async checkAccessCode() {
                    return { shareId: 'sid1' };
                },
                async listShareDir() {
                    return {
                        fileListAO: {
                            folderList: [{ id: 'f1', name: '子目录' }]
                        }
                    };
                },
            };

            const folders = await parser.buildCloud189ShareFolders(
                mockCloud189,
                'https://cloud.189.cn/t/AbCdEf12',
                '',
                async () => ({
                    shareMode: 0,
                    fileName: '资源B',
                    isFolder: true,
                    shareId: 'sid1',
                    fileId: 'root'
                })
            );

            expect(folders.length).toBe(2);
        });
    });

    describe('URL 标准化', () => {
        test('应该标准化不同格式的 URL', () => {
            const urls = [
                'https://yun.139.com/w/r?linkID=abc',
                'http://yun.139.com/w/r?linkID=abc',
                'yun.139.com/w/r?linkID=abc'
            ];

            urls.forEach(url => {
                const parsed = parser.parseCloud139ShareLink(url);
                expect(parsed.linkID).toBe('abc');
            });
        });
    });
});
