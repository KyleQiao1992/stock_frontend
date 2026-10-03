import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Agent 页面才需要 Markdown/GFM；单独成懒加载模块，普通行情页无需下载解析器。
const COMPONENTS = {
  p: (props) => <p className="my-1.5 first:mt-0 last:mb-0" {...props} />,
  h1: (props) => <h1 className="mb-1.5 mt-3 text-base font-semibold text-slate-900 first:mt-0" {...props} />,
  h2: (props) => <h2 className="mb-1.5 mt-3 text-[15px] font-semibold text-slate-900 first:mt-0" {...props} />,
  h3: (props) => <h3 className="mb-1 mt-2.5 text-sm font-semibold text-slate-900 first:mt-0" {...props} />,
  ul: (props) => <ul className="my-1.5 list-disc space-y-0.5 pl-5" {...props} />,
  ol: (props) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5" {...props} />,
  li: (props) => <li className="leading-relaxed" {...props} />,
  strong: (props) => <strong className="font-semibold text-slate-900" {...props} />,
  a: (props) => <a className="text-blue-600 underline" target="_blank" rel="noreferrer" {...props} />,
  hr: () => <hr className="my-3 border-slate-200" />,
  blockquote: (props) => <blockquote className="my-2 border-l-2 border-slate-300 pl-3 text-slate-500" {...props} />,
  pre: (props) => <pre className="my-2 overflow-x-auto rounded-lg bg-slate-900 p-3 text-[13px] text-slate-100" {...props} />,
  code: ({ className, ...props }) =>
    /language-/.test(className || "") ? (
      <code className={className} {...props} />
    ) : (
      <code className="rounded bg-slate-100 px-1 py-0.5 text-[13px] text-pink-600" {...props} />
    ),
  table: (props) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[13px]" {...props} />
    </div>
  ),
  thead: (props) => <thead className="bg-slate-100" {...props} />,
  th: (props) => <th className="border border-slate-200 px-2 py-1 text-left font-semibold" {...props} />,
  td: (props) => <td className="border border-slate-200 px-2 py-1 align-top" {...props} />,
};

export default function AgentMarkdownMessage({ children }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
      {children}
    </ReactMarkdown>
  );
}
