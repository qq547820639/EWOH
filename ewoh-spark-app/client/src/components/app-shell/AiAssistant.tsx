import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Bot, Loader2, Send, Sparkles } from 'lucide-react';
import { aiChatStream, getAiConfigStatus } from '@/api/ai';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/hooks/queryKeys';
import { sanitizeUserText } from '@/components/AppErrorState';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  id?: string;
  /** 流式生成中（显示光标） */
  pending?: boolean;
}

/**
 * 全局 AI 助手：基于系统实时上下文（负荷/电量/事件/生产任务）调用大模型回答管理问题。
 * 出现在全局顶栏，供任一面使用。
 */
const AiAssistant = () => {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 新消息/流式增量时自动滚动到底部（打字机效果跟随）
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const configQuery = useQuery({
    queryKey: queryKeys.aiConfigStatus,
    queryFn: getAiConfigStatus,
    enabled: open,
    staleTime: 60_000,
  });

  const chatMutation = useMutation({
    mutationFn: async (question: string) => {
      const placeholderId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setMessages((prev) => [
        ...prev,
        { role: 'user', content: question },
        { role: 'assistant', content: '', id: placeholderId, pending: true },
      ]);
      const result = await aiChatStream(
        question,
        (delta) => {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === placeholderId
                ? { ...msg, content: msg.content + delta }
                : msg,
            ),
          );
        },
      );
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === placeholderId
            ? {
                ...msg,
                pending: false,
                content: result.ok
                  ? result.answer
                  : `⚠️ ${result.error ?? 'AI 服务暂不可用'}`,
              }
            : msg,
        ),
      );
    },
    onError: (error) => {
      // CLI-326：错误原文可能携带内部堆栈/接口信息，清洗后再展示给用户。
      const cleaned =
        sanitizeUserText(error instanceof Error ? error.message : '') || '请求失败';
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        // 若最后一条是占位 assistant 消息，就地替换为错误；否则追加一条
        if (last?.role === 'assistant' && last.pending) {
          return prev.map((msg, i) =>
            i === prev.length - 1 ? { ...msg, pending: false, content: `⚠️ ${cleaned}` } : msg,
          );
        }
        return [...prev, { role: 'assistant', content: `⚠️ ${cleaned}` }];
      });
    },
  });

  const submit = () => {
    const question = input.trim();
    if (!question || chatMutation.isPending) return;
    setMessages((prev) => [...prev, { role: 'user', content: question }]);
    setInput('');
    chatMutation.mutate(question);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="AI 助手"
        title="AI 助手（基于实时数据问答）"
        className="inline-flex h-8 items-center gap-2 rounded-lg border border-risk-conflict bg-card px-2.5 text-sm font-medium text-risk-conflict hover:bg-risk-conflict-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-risk-conflict"
      >
        <Bot className="h-4 w-4" aria-hidden />
        <span className="hidden sm:inline">AI 助手</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="size-4 text-risk-conflict" aria-hidden />
              AI 助手
            </DialogTitle>
            <DialogDescription>
              基于系统实时数据（负荷、电量、事件、生产任务）回答你的问题。
              {configQuery.data
                ? `当前模型：${configQuery.data.model}${configQuery.data.configured ? '' : '（未配置密钥，使用服务端默认）'}`
                : '正在读取模型配置…'}
            </DialogDescription>
          </DialogHeader>

          <div
            ref={scrollRef}
            className="flex max-h-80 min-h-40 flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-muted p-3"
          >
            {messages.length === 0 && (
              <p className="m-auto text-center text-sm text-muted-foreground">
                例如：近 1 小时哪些设备负荷最高？当前有哪些未结安全事件？
              </p>
            )}
            {messages.map((msg, index) => (
              <div
                key={msg.id ?? index}
                className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'self-end bg-primary text-white'
                    : 'self-start border bg-card text-foreground'
                }`}
              >
                {msg.content}
                {msg.pending && (
                  <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-risk-conflict align-middle" />
                )}
              </div>
            ))}
            {chatMutation.isPending && messages[messages.length - 1]?.role !== 'assistant' && (
              <div className="flex items-center gap-2 self-start rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                正在结合实时数据思考…
              </div>
            )}
          </div>

          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder="输入问题，Enter 发送，Shift+Enter 换行…"
              rows={2}
              className="min-h-0 flex-1 resize-none rounded-lg border border-border p-3 text-sm outline-none focus:border-risk-conflict"
            />
            <Button
              type="button"
              onClick={submit}
              disabled={chatMutation.isPending || !input.trim()}
              className="inline-flex items-center gap-2"
            >
              <Send className="size-4" aria-hidden />
              发送
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default AiAssistant;