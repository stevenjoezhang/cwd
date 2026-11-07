import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../bindings';
import { sendCommentNotification, sendCommentReplyNotification } from './email';

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn() }));

vi.mock('nodemailer', () => ({
	createTransport: () => ({ sendMail }),
}));

const smtp = { host: 'smtp.example.com', port: 465, user: 'sender@example.com', pass: 'test-only', secure: true };
const env = {
	CWD_DB: {
		prepare: () => ({
			run: async () => ({ success: true }),
			bind: () => ({ all: async () => ({ results: [{ key: 'comment_admin_email', value: 'admin@example.com' }] }) }),
		}),
	},
} as unknown as Bindings;

/** Return the generated email without sending it to an external service. */
function sentHtml(): string {
	expect(sendMail).toHaveBeenCalledOnce();
	return sendMail.mock.calls[0][0].html;
}

/** Render an administrator notification with optional input and template overrides. */
async function notifyAdmin(overrides: Partial<Parameters<typeof sendCommentNotification>[1]> = {}, template?: string) {
	await sendCommentNotification(
		env,
		{
			postTitle: 'A post',
			postUrl: 'https://example.com/post/',
			commentAuthor: 'Reader',
			commentContent: '<p>A <strong>formatted</strong> comment</p>',
			...overrides,
		},
		smtp,
		template
	);
	return sentHtml();
}

/** Render a reply notification with optional input and template overrides. */
async function notifyReply(overrides: Partial<Parameters<typeof sendCommentReplyNotification>[1]> = {}, template?: string) {
	await sendCommentReplyNotification(
		env,
		{
			toEmail: 'reader@example.com',
			toName: 'Reader',
			postTitle: 'A post',
			postUrl: 'https://example.com/post/',
			parentComment: '<p>Original comment</p>',
			replyAuthor: 'Another reader',
			replyContent: '<p>A <em>formatted</em> reply</p>',
			...overrides,
		},
		smtp,
		template
	);
	return sentHtml();
}

describe('email notification HTML safety', () => {
	beforeEach(() => {
		sendMail.mockReset().mockResolvedValue({ messageId: 'local-test' });
		vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('escapes administrator notification titles and author names', async () => {
		const html = await notifyAdmin({ postTitle: '<img src=x onerror="alert(1)">', commentAuthor: '<b>&\"\'</b>' });

		expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
		expect(html).toContain('&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
		expect(html).not.toContain('<img');
	});

	it('escapes reply notification metadata in existing custom templates', async () => {
		const html = await notifyReply(
			{ toEmail: 'reader+tag&x@example.com', toName: '<img src=x>', postTitle: '<svg onload=alert(1)>', replyAuthor: '<b>author</b>' },
			'<section class="custom" style="padding: 12px">${toEmail}|${toName}|${postTitle}|${replyAuthor}</section>'
		);

		expect(html).toBe('<section class="custom" style="padding: 12px">reader+tag&amp;x@example.com|&lt;img src=x&gt;|&lt;svg onload=alert(1)&gt;|&lt;b&gt;author&lt;/b&gt;</section>');
	});

	it.each([
		'javascript:alert(1)',
		'JaVaScRiPt:alert(1)',
		' java\nscript:alert(1)',
		'data:text/html,<img src=x onerror=alert(1)>',
		'vbscript:msgbox(1)',
		'//example.com/post/',
		'/relative/post/',
	])('disables non-HTTP(S) article URLs: %s', async (postUrl) => {
		const html = await notifyAdmin({ postUrl }, '<a href="${postUrl}">article</a>');

		expect(html).toBe('<a href="">article</a>');
	});

	it('keeps HTTP(S) links and escapes their query strings', async () => {
		const html = await notifyAdmin({ postUrl: 'https://example.com/post/?a=1&b=2#comments' }, '<a href="${postUrl}">${postUrl}</a>');

		expect(html).toBe('<a href="https://example.com/post/?a=1&amp;b=2#comments">https://example.com/post/?a=1&amp;b=2#comments</a>');
	});

	it('prevents URL attribute breakout in reply notification links', async () => {
		const html = await notifyReply({ postUrl: 'https://example.com/\"><img src=x onerror=alert(1)>' }, '<a href="${postUrl}">article</a>');

		expect(html).toContain('href="https://example.com/%22%3E%3Cimg%20src=x%20onerror=alert(1)%3E"');
		expect(html).not.toContain('<img');
	});

	it('preserves formatted comment bodies while removing unsafe HTML', async () => {
		const html = await notifyAdmin({
			commentContent: '<p><strong>Safe</strong></p><img src="https://example.com/image.png" onerror="alert(1)"><a href="javascript:alert(1)">link</a>',
		});

		expect(html).toContain('<p><strong>Safe</strong></p>');
		expect(html).toContain('<img src="https://example.com/image.png">');
		expect(html).not.toContain('onerror');
		expect(html).not.toContain('javascript:');
	});

	it('sanitizes historical parent comments and reply bodies without escaping their formatting', async () => {
		const html = await notifyReply({ parentComment: '<p>Parent</p><img src="x" onerror="alert(1)">', replyContent: '<pre><code class="language-js">hello</code></pre><img src="x" onload="alert(1)">' });

		expect(html).toContain('<p>Parent</p>');
		expect(html).toContain('<pre><code class="language-js">hello</code></pre>');
		expect(html).not.toContain('onerror');
		expect(html).not.toContain('onload');
	});

	it('keeps emotion image attributes used by existing comments', async () => {
		const html = await notifyReply({ replyContent: '<img class="tk-owo-emotion" src="https://example.com/emotion.png" alt="smile" width="24" height="24" style="width:24px;height:24px">' });

		expect(html).toContain('class="tk-owo-emotion"');
		expect(html).toContain('width="24"');
		expect(html).toContain('height="24"');
		expect(html).toMatch(/style="width:\s*24px;\s*height:\s*24px;?"/);
	});
});
