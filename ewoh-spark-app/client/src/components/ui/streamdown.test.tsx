import { renderToStaticMarkup } from 'react-dom/server';
import * as React from 'react';

// streamdown 运行时包依赖浏览器环境，node/jest 下 mock 掉；
// 本测试只验证 MarkdownAnchor 链接白名单渲染器本身。
jest.mock('streamdown', () => ({ Streamdown: () => null }));

import { MarkdownAnchor } from './streamdown';

const render = (href: string | undefined) =>
  renderToStaticMarkup(
    <MarkdownAnchor href={href}>链接文本</MarkdownAnchor>,
  );

describe('MarkdownAnchor（CLI-401 markdown 链接 scheme 白名单）', () => {
  it('renders safe http/https/mailto links as anchors', () => {
    expect(render('https://example.com/a')).toContain('href="https://example.com/a"');
    expect(render('http://example.com/a')).toContain('href="http://example.com/a"');
    expect(render('mailto:a@b.com')).toContain('href="mailto:a@b.com"');
  });

  it('degrades javascript:/data: links to non-clickable span', () => {
    const markup = render('javascript:alert(1)');
    expect(markup).not.toContain('href');
    expect(markup).toContain('data-streamdown="link-blocked"');
    expect(markup).toContain('链接文本');

    expect(render('data:text/html,x')).not.toContain('href');
    expect(render('vbscript:msgbox(1)')).not.toContain('href');
  });

  it('keeps streaming incomplete-link marker semantics', () => {
    const markup = render('streamdown:incomplete-link');
    expect(markup).toContain('href="streamdown:incomplete-link"');
    expect(markup).toContain('data-incomplete="true"');
  });

  it('degrades undefined href (empty markdown link) to span', () => {
    expect(render(undefined)).not.toContain('href=');
  });
});
