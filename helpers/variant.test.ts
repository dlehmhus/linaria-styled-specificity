import { variant } from './variant';

describe('variant', () => {
  it('should wrap a single class in :where()', () => {
    expect(variant('.primary')).toBe('&:where(.primary)');
  });
  it('should wrap a multi-class compound', () => {
    expect(variant('.a.b')).toBe('&:where(.a.b)');
  });
  it('should wrap a :not() selector', () => {
    expect(variant(':not(.small)')).toBe('&:where(:not(.small))');
  });
  it('should wrap an attribute selector', () => {
    expect(variant('[data-size=large]')).toBe('&:where([data-size=large])');
  });
});
