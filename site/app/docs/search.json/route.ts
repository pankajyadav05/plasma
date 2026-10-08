import { searchText } from '@/content/docs';

export const dynamic = 'force-static';

/** The docs' full text for the sidebar search, fetched once on first use. */
export function GET() {
  return Response.json(searchText());
}
