// Consumer side of components/Card.tsx. Also the `as` case: the emitted tag
// expression marks `Card` with `__wyw_meta` so Linaria's runtime forwards
// `as` to `Card` instead of replacing it with a bare element.
import { styled } from '@linaria/react';
import { Card } from './components/Card';

export const PromoCard = styled(Card)`
  background: navy;
  color: white;
`;
