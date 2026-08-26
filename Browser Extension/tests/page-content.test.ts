import { beforeEach, describe, expect, it } from 'vitest';
import { getConfig, setConfig } from '@/common/config';
import { extractPageContent, mergePageContent } from '@/collector/content/page-content';

/**
 * Content capture reads what the *page* published and nothing else. The exclusion tests
 * below are the load-bearing ones: if any of them fail, candidate input is leaking into a
 * record that bypasses the sensitivity policy entirely.
 */

function render(html: string): Document {
  document.body.innerHTML = html;
  document.head.innerHTML = '';
  return document;
}

function renderHead(html: string): Document {
  document.head.innerHTML = html;
  document.body.innerHTML = '';
  return document;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  setConfig({ content_capture: { ...getConfig().content_capture, enabled: true } } as never);
});

describe('candidate input is never captured', () => {
  it('ignores text typed into a contenteditable cover-letter editor', () => {
    const doc = render(`
      <h1>Software Engineer</h1>
      <div contenteditable="true" role="textbox">
        <h3>My name is Priya and I am excited about this role</h3>
      </div>
    `);
    const content = extractPageContent(doc);
    expect(content?.headline).toBe('Software Engineer');
    expect(JSON.stringify(content)).not.toContain('Priya');
  });

  it('ignores textarea and select contents', () => {
    const doc = render(`
      <h1>Apply</h1>
      <textarea>secret motivation letter</textarea>
      <select><option>Confidential Employer Ltd</option></select>
    `);
    const serialized = JSON.stringify(extractPageContent(doc));
    expect(serialized).not.toContain('secret motivation');
    expect(serialized).not.toContain('Confidential Employer');
  });

  it('never captures markup', () => {
    const doc = render('<h1>Backend <em>Engineer</em> <script>var x=1</script></h1>');
    const content = extractPageContent(doc);
    expect(content?.headline).toBe('Backend Engineer var x=1');
    expect(JSON.stringify(content)).not.toContain('<em>');
  });
});

describe('required job data', () => {
  it('reads a schema.org JobPosting out of JSON-LD', () => {
    const doc = renderHead(`
      <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "JobPosting",
        "title": "Senior Backend Engineer",
        "hiringOrganization": { "@type": "Organization", "name": "Acme Corp" },
        "jobLocation": { "address": { "addressLocality": "Pune", "addressCountry": "IN" } },
        "employmentType": "FULL_TIME",
        "identifier": { "value": "REQ-4471" }
      }
      </script>
    `);
    const job = extractPageContent(doc)?.job;
    expect(job?.source).toBe('json_ld');
    expect(job?.title).toBe('Senior Backend Engineer');
    expect(job?.company).toBe('Acme Corp');
    expect(job?.location).toBe('Pune, IN');
    expect(job?.requisition_id).toBe('REQ-4471');
  });

  it('finds a JobPosting nested inside @graph', () => {
    const doc = renderHead(`
      <script type="application/ld+json">
      {"@graph":[{"@type":"WebSite","name":"Board"},{"@type":"JobPosting","title":"QA Lead"}]}
      </script>
    `);
    expect(extractPageContent(doc)?.job?.title).toBe('QA Lead');
  });

  it('falls back to Open Graph tags when there is no JSON-LD', () => {
    const doc = renderHead(`
      <meta property="og:title" content="Data Analyst">
      <meta property="og:site_name" content="JobBoard">
    `);
    const job = extractPageContent(doc)?.job;
    expect(job?.source).toBe('meta');
    expect(job?.title).toBe('Data Analyst');
  });

  it('survives malformed JSON-LD without throwing', () => {
    const doc = renderHead('<script type="application/ld+json">{ not json </script>');
    expect(() => extractPageContent(doc)).not.toThrow();
  });
});

describe('structure and status', () => {
  it('collects section headings in order, deduplicated', () => {
    const doc = render('<h2>Personal Details</h2><h2>Experience</h2><h2>Personal Details</h2>');
    expect(extractPageContent(doc)?.sections).toEqual(['Personal Details', 'Experience']);
  });

  it('skips hidden headings', () => {
    const doc = render('<h2>Visible Step</h2><h2 aria-hidden="true">Ghost Step</h2>');
    expect(extractPageContent(doc)?.sections).toEqual(['Visible Step']);
  });

  it('captures live-region announcements', () => {
    const doc = render('<div role="status">Step 2 of 3 saved</div>');
    expect(extractPageContent(doc)?.status_text).toContain('Step 2 of 3 saved');
  });
});

describe('redaction and budget', () => {
  it('redacts contact details out of captured text', () => {
    const doc = render('<h1>Contact hr@acme.com or +91 98765 43210</h1>');
    const headline = extractPageContent(doc)?.headline ?? '';
    expect(headline).not.toContain('hr@acme.com');
    expect(headline).toContain('[REDACTED]');
  });

  it('enforces the total character budget and flags truncation', () => {
    setConfig({
      content_capture: { ...getConfig().content_capture, max_total_chars: 40, max_item_chars: 20 },
    } as never);
    const doc = render(
      Array.from({ length: 20 }, (_, i) => `<h2>Section number ${i} with a long title</h2>`).join(''),
    );
    const content = extractPageContent(doc);
    const used = (content?.sections ?? []).join('').length;
    expect(used).toBeLessThanOrEqual(40);
    expect(content?.truncated).toBe(true);
  });

  it('returns null when capture is disabled', () => {
    setConfig({ content_capture: { ...getConfig().content_capture, enabled: false } } as never);
    expect(extractPageContent(render('<h1>Anything</h1>'))).toBeNull();
  });

  it('returns null when the page published nothing', () => {
    expect(extractPageContent(render('<div><span>x</span></div>'))).toBeNull();
  });
});

describe('merging across SPA steps', () => {
  it('fills gaps without letting a later null erase a known value', () => {
    const first = extractPageContent(renderHead('<meta property="og:site_name" content="JobBoard">'));
    const second = extractPageContent(render('<h1>Step 2</h1>'));
    const merged = mergePageContent(first, second);
    expect(merged?.site_name).toBe('JobBoard');
    expect(merged?.headline).toBe('Step 2');
  });
});
