// ecosystem.config.cjs — pm2 托管灵枢 daemon（示例配置，key 从环境变量读）
// 使用：复制为 ecosystem.local.config.cjs 并填入自己的 key（已在 .gitignore 排除 .env，建议 key 放环境变量）
// 启动: pm2 start ecosystem.config.cjs
// 常用: pm2 logs lingshu / pm2 restart lingshu / pm2 save
module.exports = {
  apps: [
    {
      name: 'lingshu',
      script: 'bun',
      args: 'run src/server/main.ts',
      cwd: __dirname,
      env: {
        // 从环境变量读；或在 pm2 启动前 export，或复制本文件为 ecosystem.local.config.cjs 填入
        SILICONFLOW_API_KEY: process.env.SILICONFLOW_API_KEY || '',
        LINGSHU_PORT: process.env.LINGSHU_PORT || '7430',
      },
      autorestart: true,
      max_memory_restart: '500M',
    },
  ],
}
