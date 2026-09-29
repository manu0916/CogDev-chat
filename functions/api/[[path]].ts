type PagesEnv = { QUOTE_API: Fetcher };

// Keep the browser on cogdev-chat.pages.dev. The API Worker stays private
// and receives the original request through Cloudflare's service binding.
export const onRequest = ({ request, env }: { request: Request; env: PagesEnv }) =>
  env.QUOTE_API.fetch(request);
