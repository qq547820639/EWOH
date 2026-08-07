import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Bot, Loader2, Send, Sparkles } from 'lucide-react';
import { aiChat, getAiConfigStatus } from '@/api/ai';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/hooks/queryKeys';
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
}

/**
 * 全局 AI 助手：基于系统实时上下文（负荷/电量/事件/生产任务）调用大模型回答管理问题。
 * 出现在全局顶栏，供任一面使用。
 */
const AiAssistant = () => {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);

  const configQuery = useQuery({
    queryKey: queryKeys.aiConfigStatus,
    queryFn: getAiConfigStatus,
    enabled: open,
    staleTime: 60_000,
  });

  const chatMutation = useMutation({
    mutationFn: (question: string) => aiChat(question),
    onSuccess: (result) => {
      if (result.ok) {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: result.answer },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: `⚠️ ${result.error ?? 'AI 服务暂不可用'}`,
          },
        ]);
      }
    },
    onError: (error) => {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `⚠️ ${error instanceof Error ? error.message : '请求失败'}`,
        },
      ]);
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
        className="inline-flex h-8 items-center gap-2 rounded-lg border border-[hsl(262_83%_58%)] bg-white px-2.5 text-sm font-medium text-[hsl(262_83%_58%)] hover:bg-[hsl(262_83%_96%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(262_83%_58%)]"
      >
        <Bot className="h-4 w-4" aria-hidden />
        <span className="hidden sm:inline">AI 助手</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="size-4 text-[hsl(262_83%_58%)]" aria-hidden />
              AI 助手
            </DialogTitle>
            <DialogDescription>
              基于系统实时数据（负荷、电量、事件、生产任务）回答你的问题。
              {configQuery.data
                ? `当前模型：${configQuery.data.model}${configQuery.data.configured ? '' : '（未配置密钥，使用服务端默认）'}`
                : '正在读取模型配置…'}
            </DialogDescription>
          </DialogHeader>

          <div className="flex max-h-80 min-h-40 flex-col gap-3 overflow-y-auto rounded-lg border border-[hsl(220_14%_89%)] bg-[hsl(220_14%_96%)] p-3">
            {messages.length === 0 && (
              <p className="m-auto text-center text-sm text-[hsl(218_10%_42%)]">
                例如：近 1 小时哪些设备负荷最高？当前有哪些未结安全事件？
              </p>
            )}
            {messages.map((msg, index) => (
              <div
                key={index}
                className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'self-end bg-[hsl(221_83%_53%)] text-white'
                    : 'self-start border bg-white text-[hsl(220_14%_14%)]'
                }`}
              >
                {msg.content}
              </div>
            ))}
            {chatMutation.isPending && (
              <div className="flex items-center gap-2 self-start rounded-lg border bg-white px-3 py-2 text-sm text-[hsl(218_10%_42%)]">
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
              className="min-h-0 flex-1 resize-none rounded-lg border border-[hsl(220_14%_89%)] p-3 text-sm outline-none focus:border-[hsl(262_83%_58%)]"
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