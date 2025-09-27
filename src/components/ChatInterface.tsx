import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Plus, Send, MoreHorizontal } from 'lucide-react';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  isStreaming?: boolean;
  isError?: boolean;
}

const formatTime = (iso: string) => {
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch (_) {
    return '';
  }
};

const extractText = (event: unknown): string => {
  if (!event || typeof event !== 'object') return '';
  const payload = event as Record<string, unknown>;

  if (typeof payload.output_text === 'string') return payload.output_text;

  const delta = payload.delta as Record<string, unknown> | undefined;
  if (delta && typeof delta.output_text === 'string') return delta.output_text;

  const content = payload.content;
  if (Array.isArray(content) && content[0] && typeof content[0] === 'object') {
    const first = content[0] as Record<string, unknown>;
    if (typeof first.text === 'string') return first.text;
  }

  const choices = payload.choices as unknown;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === 'object') {
    const choice = choices[0] as Record<string, unknown>;
    const choiceDelta = choice.delta as Record<string, unknown> | undefined;
    if (choiceDelta && typeof choiceDelta.content === 'string') return choiceDelta.content;
    if (choiceDelta && Array.isArray(choiceDelta.content) && choiceDelta.content[0]) {
      const first = choiceDelta.content[0] as Record<string, unknown>;
      if (typeof first.text === 'string') return first.text;
    }

    if (choice.message && typeof choice.message === 'object') {
      const message = choice.message as Record<string, unknown>;
      if (typeof message.content === 'string') return message.content;
      if (Array.isArray(message.content) && message.content[0]) {
        const first = message.content[0] as Record<string, unknown>;
        if (typeof first.text === 'string') return first.text;
      }
    }

    if (typeof choice.text === 'string') return choice.text;
  }

  return '';
};

export function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<Message[]>([]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const scrollToBottom = useCallback((smooth = true) => {
    const behavior = smooth ? 'smooth' : 'auto';
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  useEffect(() => {
    scrollToBottom(messages.length > 1);
  }, [messages, scrollToBottom]);

  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, []);

  useEffect(() => {
    adjustTextareaHeight();
  }, [input, adjustTextareaHeight]);

  const resetChat = () => {
    setMessages([]);
    setInput('');
    setIsSending(false);
    queueMicrotask(() => textareaRef.current?.focus());
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || isSending) return;

    const now = new Date();
    const userMessage: Message = {
      id: `user-${now.getTime()}`,
      role: 'user',
      content: text,
      createdAt: now.toISOString()
    };

    const assistantMessage: Message = {
      id: `assistant-${now.getTime()}`,
      role: 'assistant',
      content: '',
      createdAt: new Date(now.getTime() + 1).toISOString(),
      isStreaming: true
    };

    setMessages(prev => [...prev, userMessage, assistantMessage]);
    setInput('');
    setIsSending(true);

    const history = [...messagesRef.current, userMessage]
      .filter(msg => !msg.isError)
      .map(msg => ({ role: msg.role, content: msg.content }));

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, history })
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(detail || `请求失败 (${response.status})`);
      }

      if (!response.body) {
        throw new Error('服务器没有返回内容');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let accumulated = '';
      let hasError = false;

      const updateAssistant = (next: Partial<Message>) => {
        setMessages(prev =>
          prev.map(msg =>
            msg.id === assistantMessage.id
              ? { ...msg, ...next }
              : msg
          )
        );
      };

      const processPayload = (payload: string) => {
        if (!payload || payload === '[DONE]' || hasError) return;

        try {
          const event = JSON.parse(payload);
          if (event?.error) {
            const message = event.error?.message || event.error?.body || '请求失败';
            throw new Error(typeof message === 'string' ? message : '请求失败');
          }

          const delta = extractText(event);
          if (delta) {
            accumulated += delta;
            updateAssistant({ content: accumulated, isStreaming: true });
            scrollToBottom();
          }
        } catch (err) {
          hasError = true;
          const message = err instanceof Error ? err.message : '解析失败';
          updateAssistant({
            content: `[错误] ${message}`,
            isStreaming: false,
            isError: true
          });
        }
      };

      const flushBuffer = (force = false) => {
        let separatorIndex;
        while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          const lines = rawEvent.split(/\r?\n/);
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            processPayload(payload);
            if (hasError) return;
          }
        }

        if (force && buffer.trim()) {
          const remainder = buffer.trim();
          const lines = remainder.split(/\r?\n/);
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            processPayload(payload);
            if (hasError) return;
          }
          buffer = '';
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          flushBuffer(true);
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        flushBuffer();
      }

      if (!hasError) {
        updateAssistant({
          content: accumulated || '(无响应内容)',
          isStreaming: false
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '请求失败';
      setMessages(prev =>
        prev.map(msg =>
          msg.id === assistantMessage.id
            ? {
                ...msg,
                content: `[错误] ${message}`,
                isStreaming: false,
                isError: true
              }
            : msg
        )
      );
    } finally {
      setIsSending(false);
      scrollToBottom();
      queueMicrotask(() => textareaRef.current?.focus());
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter') return;

    if (event.altKey) {
      event.preventDefault();
      const target = event.currentTarget;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const value = target.value;
      const insertion = '\n';
      target.value = `${value.slice(0, start)}${insertion}${value.slice(end)}`;
      const cursor = start + insertion.length;
      target.setSelectionRange(cursor, cursor);
      setInput(target.value);
      return;
    }

    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      void handleSend();
    }
  };

  const hasMessages = messages.length > 0;

  return (
    <div className="retro-terminal">
      <div className="terminal-header">
        <div className="terminal-title">
          <span className="terminal-symbol">&gt;</span>
          <span className="blinking-cursor">_</span>
          <span className="title-text">CHAT_SESSION.EXE</span>
        </div>
        <div className="terminal-controls">
          <div className="control-dot" />
          <div className="control-dot" />
          <div className="control-dot" />
        </div>
      </div>

      <div className="chat-container">
        <div className="chat-messages">
          {!hasMessages && (
            <div className="welcome-message">
              <div className="ascii-art">
                ╔══════════════════════════════╗<br />
                ║&nbsp;&nbsp;RETRO CHAT SYSTEM - v1.0.1&nbsp;&nbsp;║<br />
                ║&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;║<br />
                ╚══════════════════════════════╝
              </div>
            </div>
          )}

          {messages.map((message, index) => {
            const isUser = message.role === 'user';
            const showTyping = message.role === 'assistant' && message.isStreaming;

            return (
              <div
                key={message.id}
                className={`message ${isUser ? 'user-message' : 'ai-message'}${message.isError ? ' error-message' : ''}`}
              >
                <div className="message-header">
                  <span className="message-prefix">{isUser ? '[USER]' : '[SYSTEM]'}</span>
                  <span className="message-time">{formatTime(message.createdAt)}</span>
                </div>
                <div className="message-content">
                  <span className="prompt-symbol">&gt;</span>
                  <span>{message.content}</span>
                </div>
                {showTyping && index === messages.length - 1 && (
                  <div className="typing-indicator">
                    <MoreHorizontal size={16} className="typing-icon" />
                    <span>处理中...</span>
                  </div>
                )}
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        <div className="input-section">
          <div className="input-container">
            <div className="input-prompt">
              <span className="prompt-symbol">&gt;</span>
            </div>
            <textarea
              ref={textareaRef}
              value={input}
              placeholder="输入您的消息..."
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              className="chat-input"
              rows={1}
              disabled={isSending}
            />
          </div>
          <div className="button-group">
            <button
              type="button"
              onClick={() => void handleSend()}
              className="action-button send-button"
              disabled={!input.trim() || isSending}
            >
              <Send size={16} />
              <span>{hasMessages ? '继续对话' : '开始对话'}</span>
            </button>
            <button
              type="button"
              onClick={resetChat}
              className="action-button new-chat-button"
              disabled={messages.length === 0 && !input}
            >
              <Plus size={16} />
              <span>新对话</span>
            </button>
          </div>
        </div>
      </div>

      <div className="scanlines" aria-hidden="true" />
    </div>
  );
}
