import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, normalizePagination, paginate } from './pagination';

const items = Array.from({ length: 250 }, (_, index) => index + 1);

describe('pagination', () => {
  describe('normalizePagination', () => {
    it('applies the default page and limit when omitted', () => {
      expect(normalizePagination()).toEqual({ page: 1, limit: DEFAULT_PAGE_LIMIT });
    });

    it('clamps page to a minimum of 1', () => {
      expect(normalizePagination({ page: 0 }).page).toBe(1);
      expect(normalizePagination({ page: -5 }).page).toBe(1);
    });

    it('clamps limit to the range [1, MAX_PAGE_LIMIT]', () => {
      expect(normalizePagination({ limit: 0 }).limit).toBe(1);
      expect(normalizePagination({ limit: -10 }).limit).toBe(1);
      expect(normalizePagination({ limit: MAX_PAGE_LIMIT + 1 }).limit).toBe(MAX_PAGE_LIMIT);
    });

    it('falls back to defaults for non-finite values', () => {
      expect(normalizePagination({ page: Number.NaN, limit: Number.POSITIVE_INFINITY })).toEqual({
        page: 1,
        limit: DEFAULT_PAGE_LIMIT,
      });
    });
  });

  describe('paginate', () => {
    it('returns the first page with metadata by default', () => {
      const result = paginate(items);

      expect(result.items).toHaveLength(DEFAULT_PAGE_LIMIT);
      expect(result.items[0]).toBe(1);
      expect(result.items[result.items.length - 1]).toBe(DEFAULT_PAGE_LIMIT);
      expect(result.total).toBe(items.length);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(DEFAULT_PAGE_LIMIT);
    });

    it('returns the requested page', () => {
      const result = paginate(items, { page: 2, limit: 10 });

      expect(result.items[0]).toBe(11);
      expect(result.items).toHaveLength(10);
      expect(result.page).toBe(2);
      expect(result.limit).toBe(10);
    });

    it('treats page <= 0 as the first page instead of slicing from the end', () => {
      for (const page of [0, -1, -20]) {
        const result = paginate(items, { page, limit: 20 });

        expect(result.items).toEqual(items.slice(0, 20));
        expect(result.page).toBe(1);
      }
    });

    it('treats limit <= 0 as a limit of 1', () => {
      for (const limit of [0, -1, -20]) {
        const result = paginate(items, { limit });

        expect(result.items).toEqual([1]);
        expect(result.limit).toBe(1);
      }
    });

    it('caps limit at MAX_PAGE_LIMIT', () => {
      const result = paginate(items, { limit: MAX_PAGE_LIMIT + 50 });

      expect(result.limit).toBe(MAX_PAGE_LIMIT);
      expect(result.items).toHaveLength(MAX_PAGE_LIMIT);
    });

    it('returns an empty page past the end of the items', () => {
      const result = paginate(items, { page: 1000 });

      expect(result.items).toEqual([]);
      expect(result.total).toBe(items.length);
    });

    it('reports hasMore=true when a later page still holds rows', () => {
      const result = paginate(items, { page: 2, limit: 20 });

      expect(result.hasMore).toBe(true);
      expect(result.items).toHaveLength(20);
    });

    it('reports hasMore=false on the exact last page when total is a multiple of page size', () => {
      // 40 items, page size 20: page 2 is the final FULL page.
      const exact = Array.from({ length: 40 }, (_, index) => index + 1);

      expect(paginate(exact, { page: 1, limit: 20 }).hasMore).toBe(true);
      expect(paginate(exact, { page: 2, limit: 20 }).hasMore).toBe(false);
      expect(paginate(exact, { page: 2, limit: 20 }).items).toHaveLength(20);
    });

    it('reports hasMore=false on the final partial page', () => {
      // 45 items, page size 20: page 3 holds only 5 rows and has no successor.
      const uneven = Array.from({ length: 45 }, (_, index) => index + 1);

      expect(paginate(uneven, { page: 2, limit: 20 }).hasMore).toBe(true);
      expect(paginate(uneven, { page: 3, limit: 20 }).hasMore).toBe(false);
      expect(paginate(uneven, { page: 3, limit: 20 }).items).toHaveLength(5);
    });

    it('reports hasMore=false for an empty collection', () => {
      const result = paginate([], { page: 1, limit: 20 });

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
    });
  });
});
