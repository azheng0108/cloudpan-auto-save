const path = require('path');
const Cloud139Utils = require('../utils/Cloud139Utils');
const { Cloud139Service } = require('./cloud139');

async function parseCloud139ShareFolders({ shareLink, account, accessCode }) {
    const extracted = Cloud139Utils.extractFromShareText(shareLink);
    const cleanLink = extracted ? extracted.url : shareLink;
    const effectivePasswd = accessCode || (extracted ? extracted.passwd : '');
    const { linkID } = Cloud139Utils.parseShareLink(cleanLink);
    const cloud139 = Cloud139Service.getInstance(account);
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

module.exports = {
    parseCloud139ShareFolders,
};
