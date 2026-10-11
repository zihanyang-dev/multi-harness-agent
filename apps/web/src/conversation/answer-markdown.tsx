import { memo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const plugins = [remarkGfm];
const components: Components = {
  img: () => null,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

export const AnswerMarkdown = memo(function AnswerMarkdown({ text }: { text: string }) {
  return (
    <Markdown skipHtml remarkPlugins={plugins} components={components}>
      {text}
    </Markdown>
  );
});
