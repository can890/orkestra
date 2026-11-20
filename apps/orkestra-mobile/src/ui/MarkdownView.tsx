import { Fragment, useMemo, useState } from 'react';
import { parseMarkdown, type InlineToken, type MarkdownBlock } from '@/core/markdown';
import { CheckIcon, CopyIcon } from './icons';

function InlineNodes(props: { tokens: InlineToken[] }) {
  return (
    <>
      {props.tokens.map((token, index) => {
        switch (token.kind) {
          case 'text':
            return <Fragment key={index}>{token.text}</Fragment>;
          case 'code':
            return (
              <code key={index} className="md-inline-code">
                {token.code}
              </code>
            );
          case 'bold':
            return (
              <strong key={index}>
                <InlineNodes tokens={token.children} />
              </strong>
            );
          case 'italic':
            return (
              <em key={index}>
                <InlineNodes tokens={token.children} />
              </em>
            );
          case 'strike':
            return (
              <del key={index}>
                <InlineNodes tokens={token.children} />
              </del>
            );
          case 'link':
            return (
              <a
                key={index}
                href={token.href}
                target="_blank"
                rel="noopener noreferrer"
                className="md-link"
              >
                {token.label}
              </a>
            );
        }
      })}
    </>
  );
}

function CodeBlock(props: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(props.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Kopyalama izin verilmediyse sessizce geç.
    }
  }

  return (
    <div className="md-code-card">
      <div className="md-code-header">
        <span className="md-code-lang">{props.language || 'kod'}</span>
        <button type="button" className="md-copy-btn" onClick={() => void handleCopy()}>
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
          <span>{copied ? 'Kopyalandı' : 'Kopyala'}</span>
        </button>
      </div>
      <pre className="md-code-pre">
        <code>{props.code}</code>
      </pre>
    </div>
  );
}

function BlockNode(props: { block: MarkdownBlock }) {
  const { block } = props;
  switch (block.kind) {
    case 'heading': {
      const Tag = `h${block.level}` as const;
      return (
        <Tag className={`md-h md-h${block.level}`}>
          <InlineNodes tokens={block.tokens} />
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p className="md-p">
          <InlineNodes tokens={block.tokens} />
        </p>
      );
    case 'code':
      return <CodeBlock language={block.language} code={block.code} />;
    case 'list': {
      const ListTag = block.ordered ? 'ol' : 'ul';
      return (
        <ListTag className={block.ordered ? 'md-ol' : 'md-ul'}>
          {block.items.map((item, idx) => (
            <li key={idx}>
              <InlineNodes tokens={item} />
            </li>
          ))}
        </ListTag>
      );
    }
    case 'blockquote':
      return (
        <blockquote className="md-quote">
          {block.lines.map((line, idx) => (
            <p key={idx}>
              <InlineNodes tokens={line} />
            </p>
          ))}
        </blockquote>
      );
    case 'table':
      return (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {block.headers.map((cell, idx) => (
                  <th key={idx}>
                    <InlineNodes tokens={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIdx) => (
                <tr key={rowIdx}>
                  {row.map((cell, cellIdx) => (
                    <td key={cellIdx}>
                      <InlineNodes tokens={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'hr':
      return <hr className="md-hr" />;
  }
}

export function MarkdownView(props: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(props.text), [props.text]);
  return (
    <div className="md-root">
      {blocks.map((block, index) => (
        <BlockNode key={index} block={block} />
      ))}
    </div>
  );
}
