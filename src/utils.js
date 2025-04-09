/**
 * 工具函数模块
 * 提供与 Cursor API 通信所需的各种辅助函数
 */
const { v4: uuidv4 } = require('uuid'); // 导入 UUID 生成函数，用于创建唯一标识符
const zlib = require('zlib'); // 导入压缩/解压缩库，用于处理压缩数据
const $root = require('./message.js'); // 导入消息定义模块，包含 Protocol Buffer 生成的类

// 用于匹配消息中系统和用户部分的正则表达式
const regex = /<\|BEGIN_SYSTEM\|>.*?<\|END_SYSTEM\|>.*?<\|BEGIN_USER\|>.*?<\|END_USER\|>/s;

/**
 * 将消息数组转换为十六进制格式的二进制数据
 * @param {Array} messages - 消息对象数组，包含用户和助手的消息
 * @param {string} modelName - 使用的模型名称
 * @returns {Buffer} - 返回十六进制编码的二进制数据，用于发送到 Cursor API
 */
async function stringToHex(messages, modelName) {
  // 格式化消息，将角色转换为数字表示（1=用户，2=助手）并添加唯一ID
  const formattedMessages = messages.map((msg) => ({
    ...msg,
    role: msg.role === 'user' ? 1 : 2,
    message_id: uuidv4(),
  }));

  // 创建完整的消息对象，包含各种必要的元数据
  const message = {
    messages: formattedMessages, // 格式化后的消息数组
    instructions: {
      instruction: 'Always respond in 中文', // 指示模型始终用中文回复
    },
    projectPath: '/path/to/project', // 项目路径（占位）
    model: {
      name: modelName, // 使用的模型名称
      empty: '', // 空字段，可能是为了兼容性
    },
    requestId: uuidv4(), // 请求ID，确保请求唯一性
    summary: '', // 摘要（这里为空）
    conversationId: uuidv4(), // 对话ID，用于标识一个会话
  };
  
  // 验证消息格式是否正确
  const errMsg = $root.ChatMessage.verify(message);
  if (errMsg) throw Error(errMsg);

  // 创建 Protocol Buffer 消息实例
  const messageInstance = $root.ChatMessage.create(message);

  // 编码消息为二进制 buffer
  const buffer = $root.ChatMessage.encode(messageInstance).finish();
  
  // 将 buffer 转换为特定格式的十六进制字符串：
  // 1. 前10个字符是长度的十六进制表示（左填充0）
  // 2. 后面是 buffer 的十六进制表示
  const hexString = (buffer.length.toString(16).padStart(10, '0') + buffer.toString('hex')).toUpperCase();

  // 将十六进制字符串转换回 Buffer 并返回
  return Buffer.from(hexString, 'hex');
}

/**
 * 将从 Cursor API 接收到的数据块转换为 UTF-8 字符串
 * @param {Buffer} chunk - 接收到的数据块
 * @returns {string} - 解码后的 UTF-8 文本
 */
async function chunkToUtf8String(chunk) {
  try {
    // 将二进制块转换为十六进制字符串
    let hex = Buffer.from(chunk).toString('hex');

    let offset = 0; // 当前处理位置
    let results = []; // 存储解析出的消息结果

    // 循环解析可能包含多个消息的数据块
    while (offset < hex.length) {
      // 确保还有足够的数据来读取长度前缀
      if (offset + 10 > hex.length) break;

      // 读取十六进制格式的数据长度（前10个字符）
      const dataLength = parseInt(hex.slice(offset, offset + 10), 16);
      offset += 10;

      // 确保剩余数据足够读取完整消息
      if (offset + dataLength * 2 > hex.length) break;

      // 提取消息的十六进制表示
      const messageHex = hex.slice(offset, offset + dataLength * 2);
      offset += dataLength * 2;

      // 将十六进制转换为 Buffer，然后解码为消息对象
      const messageBuffer = Buffer.from(messageHex, 'hex');
      const message = $root.ResMessage.decode(messageBuffer);
      results.push(message.msg); // 添加消息文本到结果数组
    }

    // 如果没有成功解析出任何消息，尝试解压缩处理
    if (results.length == 0) {
      return gunzip(chunk);
    }
    // 将所有解析出的消息拼接为一个字符串
    return results.join('');
  } catch (err) {
    // 如果解析过程出错，尝试解压缩处理
    return gunzip(chunk);
  }
}

/**
 * 解压缩 gzip 格式的数据块
 * @param {Buffer} chunk - 压缩的数据块
 * @returns {Promise<string>} - 解压后的文本
 */
function gunzip(chunk) {
  return new Promise((resolve, reject) => {
    // 解压数据（跳过前5个字节，可能是协议头）
    zlib.gunzip(chunk.slice(5), (err, decompressed) => {
      if (err) {
        // 解压失败时返回空字符串
        resolve('');
      } else {
        // 解压成功后转换为文本
        const text = decompressed.toString('utf-8');
        // 检查是否包含完整的系统和用户标记（这种情况下通常不需要处理）
        if (regex.test(text)) {
          resolve('');
        } else {
          resolve(text);
        }
      }
    });
  });
}

/**
 * 生成指定长度和字符集的随机 ID
 * @param {Object} options - 配置选项
 * @param {number} options.size - ID 长度
 * @param {string} options.dictType - 字典类型：'alphabet'（字母）, 'max'（字母、数字和特殊字符）, 或默认（数字）
 * @param {string} [options.customDict] - 自定义字符集
 * @returns {string} - 生成的随机 ID
 */
function getRandomIDPro({ size, dictType, customDict }) {
  let random = '';
  // 根据指定类型选择字符集，或使用自定义字符集
  if (!customDict) {
    switch (dictType) {
      case 'alphabet':
        // 字母字符集（大小写字母）
        customDict = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
        break;
      case 'max':
        // 最大字符集（字母、数字和特殊字符）
        customDict = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-';
        break;
      default:
        // 默认使用数字字符集
        customDict = '0123456789';
    }
  }
  // 生成指定长度的随机字符串
  for (; size--; ) random += customDict[(Math.random() * customDict.length) | 0];
  return random;
}

// 导出模块的函数
module.exports = {
  stringToHex,      // 消息转十六进制
  chunkToUtf8String, // 数据块转文本
  getRandomIDPro,   // 生成随机 ID
};
