/**
 * Task Naming Service 测试
 * 迁移自 test-task-naming-service.js
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { TaskNamingService } from '../src/services/taskNamingService';

describe('TaskNamingService', () => {
    let service: any;

    beforeEach(() => {
        service = new TaskNamingService();
    });

    describe('parseMediaFileName', () => {
        test('应该正确解析标准媒体文件名', () => {
            const parsed = service.parseMediaFileName('The.Show.S01E02.1080p.WEB-DL.x265.AAC.mkv');
            
            expect(parsed.title).toBe('The Show');
            expect(parsed.season_episode).toBe('S01E02');
            expect(parsed.videoFormat).toBe('1080p');
            expect(parsed.videoSource).toBe('WEB-DL');
        });

        test('应该解析不同格式的剧集标记', () => {
            const parsed1 = service.parseMediaFileName('Show.2024.S02E15.mkv');
            expect(parsed1.season_episode).toBe('S02E15');

            const parsed2 = service.parseMediaFileName('Show.E10.mkv');
            expect(parsed2.season_episode).toContain('E10');
        });

        test('应该处理没有剧集信息的文件', () => {
            const parsed = service.parseMediaFileName('Movie.2024.1080p.BluRay.mkv');
            expect(parsed.title).toBeTruthy();
        });
    });

    describe('renderJinjaTemplate', () => {
        test('应该正确渲染 Jinja 模板', () => {
            const data = {
                title: 'The Show',
                season_episode: 'S01E02',
                fileExt: '.mkv'
            };
            
            const rendered = service.renderJinjaTemplate('{{ title }} - {{ season_episode }}{{ fileExt }}', data);
            expect(rendered).toBe('The Show - S01E02.mkv');
        });

        test('应该处理缺失的模板变量', () => {
            const data = { title: 'Show' };
            const rendered = service.renderJinjaTemplate('{{ title }} - {{ missing }}', data);
            expect(rendered).toContain('Show');
        });
    });

    describe('generateFileName', () => {
        test('应该根据模板生成文件名', () => {
            const oldFile = { name: 'old.mkv' };
            const episode = { name: '新剧', season: '1', episode: '3', extension: '.mkv' };
            const movie = { name: '新剧', year: '2024' };
            
            const generated = service.generateFileName(oldFile, episode, movie, '{name} - {se}{ext}');
            expect(generated).toBe('新剧 - S01E03.mkv');
        });

        test('应该支持多种模板格式', () => {
            const oldFile = { name: 'test.mp4' };
            const episode = { name: 'Series', season: '2', episode: '5', extension: '.mp4' };
            const movie = { name: 'Series', year: '2023' };
            
            const generated = service.generateFileName(oldFile, episode, movie, '{name}.{se}.{year}{ext}');
            expect(generated).toContain('Series');
            expect(generated).toContain('S02E05');
        });
    });

    describe('sanitizeFileName', () => {
        test('应该移除非法字符', () => {
            const sanitized = service.sanitizeFileName('A<>:"/\\|?*B   C.mkv');
            expect(sanitized).toBe('AB C.mkv');
        });

        test('应该压缩多余空格', () => {
            const sanitized = service.sanitizeFileName('File    Name.mp4');
            expect(sanitized).toBe('File Name.mp4');
        });

        test('应该处理边缘情况', () => {
            expect(service.sanitizeFileName('')).toBe('');
            // 空白字符串会被清理为空字符串
            const result = service.sanitizeFileName('   ');
            expect(result.trim()).toBe('');
        });
    });
});
