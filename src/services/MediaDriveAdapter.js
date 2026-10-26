/**
 * MediaDriveAdapter - 影视刮削驱动层抽象解耦
 * 统一抹平 139 移动云盘 (HCY ID 树协议) 与 OpenList/AList (虚拟路径协议) 的差异
 * 严格遵从目录互斥隔离铁律：源目录 !== 目标目录，且目标目录不能为源目录子目录
 */

const logger = require('../utils/logger');

class MediaDriveAdapter {
    constructor(driveType) {
        this.driveType = driveType;
    }

    /**
     * 校验源目录与目标目录的合法性与互斥隔离
     * @param {string} sourceRef
     * @param {string} targetRef
     * @param {string} [sourcePath]
     * @param {string} [targetPath]
     * @returns {{ valid: boolean, reason?: string }}
     */
    validateDirs(sourceRef, targetRef, sourcePath = '', targetPath = '') {
        const sRef = String(sourceRef || '').trim();
        const tRef = String(targetRef || '').trim();

        if (!sRef || !tRef) {
            return { valid: false, reason: '源目录或目标目录引用为空' };
        }
        if (sRef === tRef) {
            return { valid: false, reason: '源目录与目标目录不能是同一个目录' };
        }

        const sPath = String(sourcePath || sRef).trim().replace(/\/+$/, '');
        const tPath = String(targetPath || tRef).trim().replace(/\/+$/, '');

        if (sPath && tPath) {
            if (sPath === tPath) {
                return { valid: false, reason: '源目录与目标目录路径完全相同' };
            }
            if (tPath.startsWith(sPath + '/')) {
                return { valid: false, reason: '目标目录不能位于源目录的子目录中' };
            }
        }

        return { valid: true };
    }

    async listAll(dirRef) {
        throw new Error('listAll not implemented');
    }

    async ensureDir(parentRef, name) {
        throw new Error('ensureDir not implemented');
    }

    async rename(ref, newName) {
        throw new Error('rename not implemented');
    }

    async batchMove(refs, targetDirRef) {
        throw new Error('batchMove not implemented');
    }
}

class Cloud139DriveAdapter extends MediaDriveAdapter {
    constructor(cloud139Service) {
        super('cloud139');
        if (!cloud139Service) throw new Error('Cloud139DriveAdapter: cloud139Service 实例不能为空');
        this.client = cloud139Service;
    }

    /**
     * 分页全量拉取指定目录下的内容（含子文件夹与文件）
     */
    async listAll(dirRef) {
        const rawList = await this.client.listDiskDirAll(dirRef || '/');
        return (rawList || []).map(item => ({
            ref: String(item.fileId || item.id || ''),
            name: item.fileName || item.name || '',
            isDir: Boolean(item.fileType === 1 || item.isDir || item.isFolder),
            size: Number(item.fileSize || item.size || 0),
            parentRef: String(item.parentFileId || dirRef || '/')
        }));
    }

    /**
     * 幂等创建子目录（存在则直接返回 fileId，不存在则调用 createFolderHcy）
     */
    async ensureDir(parentRef, name) {
        const cleanName = String(name || '').trim();
        const pRef = String(parentRef || '/');
        // 1. 优先查重，防止重复创建
        const existing = await this.client.findFolderByName(pRef, cleanName);
        const existingId = typeof existing === 'string' ? existing : (existing?.fileId || existing?.id || null);
        if (existingId) {
            return String(existingId);
        }
        // 2. 不存在则创建
        const created = await this.client.createFolderHcy(pRef, cleanName);
        const newId = created?.fileId || created?.catalogID || created?.id;
        if (!newId) throw new Error(`创建 139 目录失败: 未返回有效 ID (name=${cleanName})`);
        return String(newId);
    }

    async rename(ref, newName) {
        await this.client.renameFile(ref, newName);
    }

    async batchMove(refs, targetDirRef) {
        const idList = Array.isArray(refs) ? refs.filter(Boolean) : [refs];
        if (!idList.length) return;
        await this.client.batchMoveHcy(idList, targetDirRef);
    }
}

class OpenListDriveAdapter extends MediaDriveAdapter {
    constructor(alistService) {
        super('openlist');
        if (!alistService) throw new Error('OpenListDriveAdapter: alistService 实例不能为空');
        this.client = alistService;
    }

    /**
     * 获取指定路径下的全量文件与目录
     */
    async listAll(dirPath) {
        const res = await this.client.listDir(dirPath || '/');
        const content = res?.content || [];
        const normParent = String(dirPath || '/').replace(/\/+$/, '');
        return content.map(item => {
            const itemPath = `${normParent}/${item.name}`.replace(/\/+/g, '/');
            return {
                ref: itemPath,
                name: item.name,
                isDir: Boolean(item.is_dir),
                size: Number(item.size || 0),
                parentRef: normParent || '/'
            };
        });
    }

    /**
     * 幂等创建目录
     */
    async ensureDir(parentPath, name) {
        const normParent = String(parentPath || '/').replace(/\/+$/, '');
        const targetPath = `${normParent}/${name}`.replace(/\/+/g, '/');
        await this.client.mkdir(targetPath);
        return targetPath;
    }

    async rename(filePath, newName) {
        await this.client.rename(filePath, newName);
    }

    async batchMove(filePaths, targetDirPath) {
        const list = Array.isArray(filePaths) ? filePaths.filter(Boolean) : [filePaths];
        if (!list.length) return;
        // OpenList 按同目录聚合 move: move(srcDir, dstDir, names)
        const groups = new Map();
        for (const p of list) {
            const lastSlash = p.lastIndexOf('/');
            const srcDir = lastSlash > 0 ? p.substring(0, lastSlash) : '/';
            const name = lastSlash >= 0 ? p.substring(lastSlash + 1) : p;
            if (!groups.has(srcDir)) groups.set(srcDir, []);
            groups.get(srcDir).push(name);
        }

        for (const [srcDir, names] of groups.entries()) {
            await this.client.move(srcDir, targetDirPath, names);
        }
    }
}

module.exports = {
    MediaDriveAdapter,
    Cloud139DriveAdapter,
    OpenListDriveAdapter
};
