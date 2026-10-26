import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import MainLayout from '../layout/MainLayout.vue';
import LoginView from '../views/LoginView.vue';
import SyncView from '../views/SyncView.vue';
import SettingsView from '../views/SettingsView.vue';
import AccountsView from '../views/AccountsView.vue';
import SystemView from '../views/SystemView.vue';
import ChannelView from '../views/ChannelView.vue';
import ScrapeView from '../views/ScrapeView.vue';
import TasksView from '../views/TasksView.vue';
import MountView from '../views/MountView.vue';
import MaintenanceView from '../views/MaintenanceView.vue';

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'Login',
    component: LoginView,
    meta: { title: '用户登录' },
  },
  {
    path: '/',
    component: MainLayout,
    redirect: '/channel',
    children: [
      // 分组 1: 基础与全局设置 (置顶以保障网络代理与初始环境优先就绪)
      {
        path: 'settings',
        name: 'Settings',
        component: SettingsView,
        meta: {
          title: '全局设置',
          badge: '核心配置',
          desc: '统一管理网络代理、Telegram、定时调度、通知渠道与安全参数',
          showSaveBtn: true,
          saveBtnText: '保存全局设置',
        },
      },
      {
        path: 'system',
        name: 'System',
        component: SystemView,
        meta: {
          title: '系统监控',
          badge: '实时流',
          desc: '查看系统健康状态、定时任务运行日志与控制台输出',
        },
      },

      // 分组 2: 139 移动云盘
      {
        path: 'accounts',
        name: 'Accounts',
        component: AccountsView,
        meta: {
          title: '云盘账号',
          badge: '多号凭据',
          desc: '多账号鉴权绑定、Token 保活与网盘容量监控',
        },
      },
      {
        path: 'channel',
        name: 'Channel',
        component: ChannelView,
        meta: {
          title: '频道监控',
          badge: '一气呵成',
          desc: 'Telegram 频道流式推送监听、免登转存、TMDB 识别与影视媒体库全自动分类整理',
          showSaveBtn: true,
          saveBtnText: '保存频道配置',
        },
      },
      {
        path: 'tasks',
        name: 'Tasks',
        component: TasksView,
        meta: {
          title: '单链追更',
          badge: '定时轮询',
          desc: '管理 139 移动云盘单链接订阅追更与自动转存任务',
        },
      },
      {
        path: 'maintenance',
        name: 'Maintenance',
        component: MaintenanceView,
        meta: {
          title: '网盘清理',
          badge: '安全回收',
          desc: '排查网盘审核拦截、特征封禁与损坏死链，支持资产柔性隔离与安全空目录修剪',
        },
      },

      // 分组 3: 影视与媒体中心
      {
        path: 'organize',
        name: 'Organize',
        alias: ['scrape'],
        component: ScrapeView,
        meta: {
          title: '媒体整理',
          badge: '智能归档',
          desc: '暂存区自动整理归档、TMDB 智能识别、分季建树归档、标准点分命名与伴随字幕配对',
          showSaveBtn: true,
          saveBtnText: '保存整理配置',
        },
      },
      {
        path: 'wash',
        name: 'Wash',
        component: ScrapeView,
        meta: {
          title: '洗版策略',
          badge: '画质裁决',
          desc: '8 项画质元数据权重比对、高画质置换淘汰、已有资产保护与杜比双版本并存豁免',
          showSaveBtn: true,
          saveBtnText: '保存洗版配置',
        },
      },
      {
        path: 'missing',
        name: 'Missing',
        alias: ['episodes', 'missing-episodes'],
        component: MaintenanceView,
        meta: {
          title: '缺集检测',
          badge: '断集巡检',
          desc: '比对 TMDB 官方分集目录与媒体库剧集，秒级定位缺更断集，支持一键补更推送',
        },
      },
      {
        path: 'mount',
        name: 'Mount',
        component: MountView,
        meta: {
          title: '媒体挂载',
          badge: '本地直链',
          desc: 'STRM 302 原生直链与 Emby 媒体库双向联动',
          showSaveBtn: true,
          saveBtnText: '保存挂载配置',
        },
      },
      {
        path: 'sync',
        name: 'Sync',
        component: SyncView,
        meta: {
          title: '资产同步',
          badge: '秒传离线',
          desc: '139 移动云盘跨号秒传与 123 网盘离线任务调度',
          showSaveBtn: true,
          saveBtnText: '保存同步配置',
        },
      },
    ],
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/channel',
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
