const path = require('path');
const cloud189Utils = require('../legacy189/utils/Cloud189Utils');
const Cloud139Utils = require('../utils/Cloud139Utils');

class TaskParserService {
    extractCloud139ShareText(shareText) {
        return Cloud139Utils.extractFromShareText(shareText);
    }

    parseCloud139ShareLink(shareLink) {
        return Cloud139Utils.parseShareLink(shareLink);
    }

    parseCloud189ShareInput(shareLink) {
        const parsed = cloud189Utils.parseCloudShare(shareLink);
        const normalizedUrl = parsed?.url || shareLink;
        const parsedAccessCode = parsed?.accessCode || '';
        const shareCode = cloud189Utils.parseShareCode(normalizedUrl);
        return {
            normalizedUrl,
            parsedAccessCode,
            shareCode,
        };
    }

    async buildCloud139ShareFolders(cloud139, shareLink, accessCode) {
        const extracted = this.extractCloud139ShareText(shareLink);
        const cleanLink = extracted ? extracted.url : shareLink;
        const effectivePasswd = accessCode || (extracted ? extracted.passwd : '');
        const { linkID } = this.parseCloud139ShareLink(cleanLink);
        const result = await cloud139.listShareDir(linkID, effectivePasswd);
        if (!result) throw new Error('获取分享信息失败');

        const rootFiles = result.fileList ?? [];
        let subFolders = result.folderList ?? [];
        let rootName = result.linkName || linkID;
        let effectiveRootFiles = rootFiles;

        if (subFolders.length === 1 && rootFiles.length === 0) {
            const singleFolder = subFolders[0];
            const singleFolderID = singleFolder.catalogID ?? singleFolder.caID;
            rootName = singleFolder.catalogName ?? singleFolder.caName;
            const childResult = await cloud139.listShareDir(linkID, effectivePasswd, singleFolderID);
            subFolders = childResult?.folderList ?? [];
            effectiveRootFiles = childResult?.fileList ?? [];
        }

        const folders = [{ id: -1, name: rootName, level: 0, hasRootFiles: effectiveRootFiles.length > 0 }];
        for (const folder of subFolders) {
            folders.push({
                id: folder.catalogID ?? folder.caID,
                name: path.join(rootName, folder.catalogName ?? folder.caName),
                level: 1,
            });
        }
        return folders;
    }

    async buildCloud189ShareFolders(cloud189, shareLink, accessCode, getShareInfo) {
        const { shareCode } = this.parseCloud189ShareInput(shareLink);
        const shareInfo = await getShareInfo(cloud189, shareCode);
        if (shareInfo.shareMode == 1) {
            if (!accessCode) {
                throw new Error('分享链接为私密链接, 请输入提取码');
            }
            const accessCodeResponse = await cloud189.checkAccessCode(shareCode, accessCode);
            if (!accessCodeResponse) {
                throw new Error('校验访问码失败');
            }
            if (!accessCodeResponse.shareId) {
                throw new Error('访问码无效');
            }
            shareInfo.shareId = accessCodeResponse.shareId;
        }
        const folders = [{ id: -1, name: shareInfo.fileName }];
        if (!shareInfo.isFolder) {
            return folders;
        }
        const result = await cloud189.listShareDir(shareInfo.shareId, shareInfo.fileId, shareInfo.shareMode, accessCode);
        if (!result?.fileListAO) return folders;
        const { folderList: subFolders = [] } = result.fileListAO;
        subFolders.forEach((folder) => {
            folders.push({ id: folder.id, name: path.join(shareInfo.fileName, folder.name) });
        });
        return folders;
    }
}

module.exports = { TaskParserService };
