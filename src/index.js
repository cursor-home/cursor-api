/**
 * Cursor API 代理服务器
 * 用于转发对 Cursor AI 的请求，支持流式和非流式输出
 */
const express = require('express'); // 导入 Express 框架，用于创建 Web 服务器
const { v4: uuidv4 } = require('uuid'); // 导入 UUID 生成函数，用于创建唯一标识符
const { stringToHex, chunkToUtf8String, getRandomIDPro } = require('./utils.js'); // 导入自定义工具函数
const app = express(); // 创建 Express 应用实例

// 中间件配置
app.use(express.json()); // 解析 JSON 请求体的中间件
app.use(express.urlencoded({ extended: true })); // 解析 URL 编码请求体的中间件，extended:true 允许解析复杂对象

/**
 * 聊天补全 API 端点
 * 与 OpenAI API 兼容的接口，转发请求到 Cursor API
 */
app.post('/v1/chat/completions', async (req, res) => {
  // 检查模型兼容性：o1 开头的模型不支持流式输出
  if (req.body.model.startsWith('o1-') && req.body.stream) {
    return res.status(400).json({
      error: 'Model not supported stream',
    });
  }

  let currentKeyIndex = 0; // 初始化当前密钥索引，用于多密钥轮换
  try {
    // 从请求体中解构必要参数
    const { model, messages, stream = false } = req.body;
    
    // 从请求头中提取授权令牌
    let authToken = req.headers.authorization?.replace('Bearer ', '');
    
    // 处理逗号分隔的多个密钥
    const keys = authToken.split(',').map((key) => key.trim());
    if (keys.length > 0) {
      // 确保 currentKeyIndex 不会越界
      if (currentKeyIndex >= keys.length) {
        currentKeyIndex = 0;
      }
      // 使用当前索引获取密钥
      authToken = keys[currentKeyIndex];
    }
    
    // 处理特殊格式的授权令牌
    if (authToken && authToken.includes('%3A%3A')) {
      authToken = authToken.split('%3A%3A')[1]; // 提取 %3A%3A 后面的部分（URL 编码的双冒号）
    }
    
    // 验证请求参数的有效性
    if (!messages || !Array.isArray(messages) || messages.length === 0 || !authToken) {
      return res.status(400).json({
        error: 'Invalid request. Messages should be a non-empty array and authorization is required',
      });
    }

    // 将消息转换为十六进制格式，适配 Cursor API 要求
    const hexData = await stringToHex(messages, model);

    // 获取 checksum，按优先级：请求头 > 环境变量 > 随机生成
    const checksum =
      req.headers['x-cursor-checksum'] ??
      process.env['x-cursor-checksum'] ??
      `zo${getRandomIDPro({ dictType: 'max', size: 6 })}${getRandomIDPro({ dictType: 'max', size: 64 })}/${getRandomIDPro({ dictType: 'max', size: 64 })}`;

    // 发送请求到 Cursor API
    // 这里是向Cursor的AI服务发送请求，Cursor是一个基于AI的代码编辑器
    // 我们使用它的API来处理聊天请求，实现与OpenAI API兼容的接口
    const response = await fetch('https://api2.cursor.sh/aiserver.v1.AiService/StreamChat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/connect+proto', // 内容类型为 Connect Protocol
        authorization: `Bearer ${authToken}`, // 授权令牌
        'connect-accept-encoding': 'gzip,br', // 接受的编码方式
        'connect-protocol-version': '1', // Connect 协议版本
        'user-agent': 'connect-es/1.4.0', // 用户代理
        'x-amzn-trace-id': `Root=${uuidv4()}`, // AWS 追踪 ID
        'x-cursor-checksum': checksum, // Cursor 校验和
        'x-cursor-client-version': '0.42.3', // Cursor 客户端版本
        'x-cursor-timezone': 'Asia/Shanghai', // 时区设置
        'x-ghost-mode': 'false', // 幽灵模式设置
        'x-request-id': uuidv4(), // 请求 ID
        Host: 'api2.cursor.sh', // 主机头
      },
      body: hexData, // 请求体为十六进制编码的数据
    });

    // 处理流式响应模式
    if (stream) {
      // 设置 SSE (Server-Sent Events) 响应头
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const responseId = `chatcmpl-${uuidv4()}`; // 生成唯一的响应 ID

      // 逐块处理响应数据
      for await (const chunk of response.body) {
        const text = await chunkToUtf8String(chunk); // 将二进制数据转换为 UTF-8 字符串

        if (text.length > 0) {
          // 以 SSE 格式发送数据块
          res.write(
            `data: ${JSON.stringify({
              id: responseId,
              object: 'chat.completion.chunk', // 对象类型为聊天补全块
              created: Math.floor(Date.now() / 1000), // 创建时间戳
              model, // 使用的模型
              choices: [
                {
                  index: 0,
                  delta: {
                    content: text, // 增量内容
                  },
                },
              ],
            })}\n\n`, // SSE 格式要求的双换行符
          );
        }
      }

      // 发送结束标志并关闭连接
      res.write('data: [DONE]\n\n');
      return res.end();
    } 
    // 处理非流式响应模式
    else {
      let text = '';
      // 收集所有响应块
      for await (const chunk of response.body) {
        text += await chunkToUtf8String(chunk);
      }
      
      // 对响应文本进行清理和格式化
      text = text.replace(/^.*<\|END_USER\|>/s, ''); // 移除用户消息标记之前的内容
      text = text.replace(/^\n[a-zA-Z]?/, '').trim(); // 移除开头的换行和可能的单个字母，并修剪空白

      // 返回符合 OpenAI API 格式的 JSON 响应
      return res.json({
        id: `chatcmpl-${uuidv4()}`, // 生成唯一的补全 ID
        object: 'chat.completion', // 对象类型为聊天补全
        created: Math.floor(Date.now() / 1000), // 创建时间戳
        model, // 使用的模型
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant', // 角色为助手
              content: text, // 响应内容
            },
            finish_reason: 'stop', // 完成原因
          },
        ],
        usage: {
          prompt_tokens: 0, // 提示词 token 数（占位符）
          completion_tokens: 0, // 补全 token 数（占位符）
          total_tokens: 0, // 总 token 数（占位符）
        },
      });
    }
  } catch (error) {
    // 错误处理
    console.error('Error:', error);
    if (!res.headersSent) { // 确保响应头尚未发送
      if (req.body.stream) {
        // 流式模式下的错误响应
        res.write(`data: ${JSON.stringify({ error: 'Internal server error' })}\n\n`);
        return res.end();
      } else {
        // 非流式模式下的错误响应
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  }
});

// 启动服务器
const PORT = process.env.PORT || 3000; // 从环境变量获取端口，默认为 3000
app.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`); // 服务器启动成功的日志
});
