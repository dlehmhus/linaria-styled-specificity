import { state } from './state';

describe('state', () => {
  it('should append a single class after the id bump', () => {
    expect(state('.img-error')).toBe('&:not(#_).img-error');
  });
  it('should append a multi-class compound', () => {
    expect(state('.a.b')).toBe('&:not(#_).a.b');
  });
  it('should append a :not() selector', () => {
    expect(state(':not(.small)')).toBe('&:not(#_):not(.small)');
  });
  it('should append an attribute selector', () => {
    expect(state('[data-state=open]')).toBe('&:not(#_)[data-state=open]');
  });
});
