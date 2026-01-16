#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as cheerio from "cheerio";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { authenticate, isAuthEnabled, type AuthResult } from "./auth.js";

// Google API credentials can come from environment (for local dev) or request parameters (for hosted)
const DEFAULT_GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const DEFAULT_GOOGLE_CX = process.env.GOOGLE_CX;

// Store auth context (in a real implementation, you'd use request context)
let currentAuthContext: AuthResult | null = null;

interface SearchResult {
  title: string;
  link: string;
  snippet: string;
  position: number;
  date?: string;
}

interface GoogleSearchResponse {
  items?: Array<{
    title: string;
    link: string;
    snippet: string;
    pagemap?: {
      metatags?: Array<{ "article:published_time"?: string }>;
    };
  }>;
  searchInformation?: {
    totalResults: string;
  };
}

interface FetchedContent {
  url: string;
  title: string;
  content: string;
  success: boolean;
  error?: string;
  wordCount?: number;
}

// Search types supported
type SearchType = "web" | "news" | "images";

async function googleSearch(
  query: string,
  numResults: number = 10,
  searchType: SearchType = "web",
  apiKey?: string,
  cx?: string
): Promise<SearchResult[]> {
  const GOOGLE_API_KEY = apiKey || DEFAULT_GOOGLE_API_KEY;
  const GOOGLE_CX = cx || DEFAULT_GOOGLE_CX;

  if (!GOOGLE_API_KEY) {
    throw new Error("GOOGLE_API_KEY is required (provide via environment variable or request parameter)");
  }
  if (!GOOGLE_CX) {
    throw new Error("GOOGLE_CX is required (provide via environment variable or request parameter)");
  }

  // Build the Google Custom Search API URL
  const baseUrl = "https://customsearch.googleapis.com/customsearch/v1";
  const params = new URLSearchParams({
    key: GOOGLE_API_KEY,
    cx: GOOGLE_CX,
    q: query,
    num: Math.min(numResults, 10).toString(), // Google API max is 10 per request
  });

  // Add search type specific parameters
  if (searchType === "news") {
    // For news, we can use tbm=nws or sort by date
    params.append("sort", "date");
  } else if (searchType === "images") {
    params.append("searchType", "image");
  }

  const response = await fetch(`${baseUrl}?${params.toString()}`);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google Custom Search API error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const data = (await response.json()) as GoogleSearchResponse;

  if (!data.items || data.items.length === 0) {
    return [];
  }

  return data.items.map((item, idx) => ({
    title: item.title,
    link: item.link,
    snippet: item.snippet || "",
    position: idx + 1,
    date: item.pagemap?.metatags?.[0]?.["article:published_time"],
  }));
}


// Improved content extraction using Readability
function extractContentWithReadability(html: string, url: string): string {
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (article && article.textContent) {
      // Clean up the text content
      return article.textContent
        .replace(/\s+/g, " ")
        .replace(/\n\s*\n\s*\n/g, "\n\n")
        .trim();
    }
  } catch {
    // Fall back to cheerio extraction
  }

  return extractContentWithCheerio(html);
}

// Fallback content extraction using Cheerio
function extractContentWithCheerio(html: string): string {
  const $ = cheerio.load(html);

  // Remove non-content elements
  $(
    "script, style, nav, footer, header, aside, noscript, svg, iframe, form, .ads, .advertisement, .sidebar, .comments, .social-share"
  ).remove();

  // Try to find main content area
  let content = "";
  const contentSelectors = [
    "article",
    "main",
    '[role="main"]',
    ".post-content",
    ".article-content",
    ".entry-content",
    ".content",
    "#content",
    ".post",
    ".blog-post",
  ];

  for (const selector of contentSelectors) {
    const element = $(selector);
    if (element.length > 0) {
      content = element.text();
      break;
    }
  }

  // Fallback to body if no content area found
  if (!content) {
    content = $("body").text();
  }

  // Clean up whitespace
  return content.replace(/\s+/g, " ").replace(/\n\s*\n\s*\n/g, "\n\n").trim();
}

// Retry logic with exponential backoff
async function fetchWithRetry(
  url: string,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
        },
        signal: AbortSignal.timeout(15000),
      });

      if (response.ok) {
        return response;
      }

      // Don't retry on client errors (4xx) except 429 (rate limit)
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new Error(`HTTP ${response.status}`);
      }

      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Unknown error");

      // Don't retry on timeout
      if (lastError.message.includes("timeout")) {
        throw lastError;
      }
    }

    // Exponential backoff
    if (attempt < maxRetries - 1) {
      const delay = baseDelay * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error("Max retries exceeded");
}

async function fetchUrl(url: string, maxLength: number = 100000): Promise<FetchedContent> {
  try {
    const response = await fetchWithRetry(url);
    const html = await response.text();

    // Extract title using cheerio
    const $ = cheerio.load(html);
    const title =
      $("title").text().trim() ||
      $('meta[property="og:title"]').attr("content") ||
      $('meta[name="title"]').attr("content") ||
      "";

    // Use Readability for better content extraction
    let text = extractContentWithReadability(html, url);

    // Calculate word count before truncation
    const wordCount = text.split(/\s+/).length;

    // Truncate to max length
    if (text.length > maxLength) {
      text = text.substring(0, maxLength) + "\n\n[Content truncated...]";
    }

    return { url, title, content: text, success: true, wordCount };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    return { url, title: "", content: "", success: false, error: errorMsg };
  }
}

async function fetchAllUrls(
  urls: string[],
  concurrency: number = 5
): Promise<FetchedContent[]> {
  const results: FetchedContent[] = new Array(urls.length);

  // Process in batches for controlled concurrency
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map((url) => fetchUrl(url)));

    batchResults.forEach((result, idx) => {
      const globalIdx = i + idx;
      if (result.status === "fulfilled") {
        results[globalIdx] = result.value;
      } else {
        results[globalIdx] = {
          url: urls[globalIdx],
          title: "",
          content: "",
          success: false,
          error: "Promise rejected",
        };
      }
    });
  }

  return results;
}


function formatResponse(
  query: string,
  searchResults: SearchResult[],
  fetchedContents: FetchedContent[],
  maxContentPerPage: number,
  searchType: SearchType
): string {
  const successCount = fetchedContents.filter((c) => c.success).length;
  const totalWords = fetchedContents.reduce((sum, c) => sum + (c.wordCount || 0), 0);

  let response = `# Deep Search Results for: "${query}"\n\n`;
  response += `**Search Type:** ${searchType}\n`;
  response += `**Results:** ${searchResults.length} found, ${successCount} pages fetched successfully\n`;
  response += `**Total Content:** ~${totalWords.toLocaleString()} words\n\n`;
  response += "---\n\n";

  for (let i = 0; i < searchResults.length; i++) {
    const search = searchResults[i];
    const fetched = fetchedContents[i];

    response += `## ${i + 1}. ${search.title}\n`;
    response += `**URL:** ${search.link}\n`;
    if (search.date) {
      response += `**Date:** ${search.date}\n`;
    }
    response += "\n";

    if (fetched?.success && fetched.content) {
      const content =
        fetched.content.length > maxContentPerPage
          ? fetched.content.substring(0, maxContentPerPage) + "\n\n[Content truncated...]"
          : fetched.content;
      response += `### Full Page Content:\n\n${content}\n\n`;
    } else if (fetched?.error) {
      response += `*Could not fetch content: ${fetched.error}*\n\n`;
      response += `**Search Snippet:** ${search.snippet}\n\n`;
    }

    response += "---\n\n";
  }

  return response;
}

// Create MCP Server
const server = new McpServer({
  name: "google-search-mcp",
  version: "2.1.0",
});

// Register the google_search tool (simple search with snippets only)
server.tool(
  "google_search",
  "Simple Google search for quick lookups. Returns snippets only without fetching full page content. For deep research with full page content, use deep_search instead.",
  {
    query: z.string().describe("Search query"),
    num_results: z
      .number()
      .min(1)
      .max(10)
      .default(10)
      .describe("Number of results to return (1-10, default: 10)"),
    google_api_key: z
      .string()
      .optional()
      .describe("Google Custom Search API key (optional, uses server default if not provided)"),
    google_cx: z
      .string()
      .optional()
      .describe("Google Custom Search Engine ID (optional, uses server default if not provided)"),
  },
  async ({ query, num_results = 10, google_api_key, google_cx }: { 
    query: string; 
    num_results?: number;
    google_api_key?: string;
    google_cx?: string;
  }) => {
    try {
      const searchResults = await googleSearch(query, num_results, "web", google_api_key, google_cx);

      if (searchResults.length === 0) {
        return {
          content: [
            { type: "text" as const, text: `No search results found for: "${query}"` },
          ],
        };
      }

      let response = `# Search Results for: "${query}"\n\n`;
      response += `**Results:** ${searchResults.length} found\n\n`;
      response += "---\n\n";

      for (const result of searchResults) {
        response += `## ${result.position}. ${result.title}\n`;
        response += `**URL:** ${result.link}\n`;
        response += `**Snippet:** ${result.snippet}\n\n`;
        response += "---\n\n";
      }

      return {
        content: [{ type: "text" as const, text: response }],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      return {
        content: [
          { type: "text" as const, text: `Error performing search: ${errorMsg}` },
        ],
        isError: true,
      };
    }
  }
);

// Register the deep_search tool
server.tool(
  "deep_search",
  "Performs a comprehensive web search using Google Custom Search API, fetching the FULL content from top results using advanced content extraction (Readability algorithm), and returning consolidated content. Supports web, news, and image search types. Includes retry logic for reliability.",
  {
    query: z.string().describe("The search query to look up"),
    num_results: z
      .number()
      .min(1)
      .max(10)
      .default(10)
      .describe("Number of results to fetch (1-10, default: 10)"),
    max_content_per_page: z
      .number()
      .min(5000)
      .max(100000)
      .default(50000)
      .describe("Maximum characters of content to return per page (5000-100000, default: 50000)"),
    search_type: z
      .enum(["web", "news", "images"])
      .default("web")
      .describe("Type of search: 'web' for general search, 'news' for news articles, 'images' for image search"),
    include_domains: z
      .string()
      .optional()
      .describe("Comma-separated list of domains to include (e.g., 'reddit.com,github.com')"),
    exclude_domains: z
      .string()
      .optional()
      .describe("Comma-separated list of domains to exclude (e.g., 'pinterest.com,facebook.com')"),
    google_api_key: z
      .string()
      .optional()
      .describe("Google Custom Search API key (optional, uses server default if not provided)"),
    google_cx: z
      .string()
      .optional()
      .describe("Google Custom Search Engine ID (optional, uses server default if not provided)"),
  },
  async ({
    query,
    num_results = 10,
    max_content_per_page = 50000,
    search_type = "web",
    include_domains,
    exclude_domains,
    google_api_key,
    google_cx,
  }: {
    query: string;
    num_results?: number;
    max_content_per_page?: number;
    search_type?: SearchType;
    include_domains?: string;
    exclude_domains?: string;
    google_api_key?: string;
    google_cx?: string;
  }) => {
    try {
      // Build query with domain filters
      let searchQuery = query;
      if (include_domains) {
        const domains = include_domains.split(",").map((d: string) => d.trim());
        searchQuery += " " + domains.map((d: string) => `site:${d}`).join(" OR ");
      }
      if (exclude_domains) {
        const domains = exclude_domains.split(",").map((d: string) => d.trim());
        searchQuery += " " + domains.map((d: string) => `-site:${d}`).join(" ");
      }

      // Step 1: Google search
      const searchResults = await googleSearch(searchQuery, num_results, search_type, google_api_key, google_cx);

      if (searchResults.length === 0) {
        return {
          content: [
            { type: "text" as const, text: `No search results found for: "${query}"` },
          ],
        };
      }

      // Step 2: Fetch all URLs with controlled concurrency
      const urls = searchResults.map((r) => r.link);
      const fetchedContents = await fetchAllUrls(urls, 5);

      // Step 3: Format and return response
      const response = formatResponse(
        query,
        searchResults,
        fetchedContents,
        max_content_per_page,
        search_type
      );

      return {
        content: [{ type: "text" as const, text: response }],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      return {
        content: [
          { type: "text" as const, text: `Error performing deep search: ${errorMsg}` },
        ],
        isError: true,
      };
    }
  }
);


// Register deep_search_news tool for convenience
server.tool(
  "deep_search_news",
  "Searches for recent news articles on a topic using Google Custom Search API, fetches full article content, and returns consolidated results. Optimized for news and current events.",
  {
    query: z.string().describe("The news topic to search for"),
    num_results: z
      .number()
      .min(1)
      .max(10)
      .default(10)
      .describe("Number of news articles to fetch (1-10, default: 10)"),
    max_content_per_page: z
      .number()
      .min(5000)
      .max(100000)
      .default(30000)
      .describe("Maximum characters per article (default: 30000)"),
    google_api_key: z
      .string()
      .optional()
      .describe("Google Custom Search API key (optional, uses server default if not provided)"),
    google_cx: z
      .string()
      .optional()
      .describe("Google Custom Search Engine ID (optional, uses server default if not provided)"),
  },
  async ({ query, num_results = 10, max_content_per_page = 30000, google_api_key, google_cx }: {
    query: string;
    num_results?: number;
    max_content_per_page?: number;
    google_api_key?: string;
    google_cx?: string;
  }) => {
    try {
      const searchResults = await googleSearch(query, num_results, "news", google_api_key, google_cx);

      if (searchResults.length === 0) {
        return {
          content: [
            { type: "text" as const, text: `No news results found for: "${query}"` },
          ],
        };
      }

      const urls = searchResults.map((r) => r.link);
      const fetchedContents = await fetchAllUrls(urls, 5);
      const response = formatResponse(
        query,
        searchResults,
        fetchedContents,
        max_content_per_page,
        "news"
      );

      return {
        content: [{ type: "text" as const, text: response }],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      return {
        content: [
          { type: "text" as const, text: `Error performing news search: ${errorMsg}` },
        ],
        isError: true,
      };
    }
  }
);

// Start the server
async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    // Write error to a file for debugging since we can't use stderr
    const fs = await import("fs");
    fs.writeFileSync("/tmp/deep-search-mcp-error.log", String(error));
    process.exit(1);
  }
}

main();
