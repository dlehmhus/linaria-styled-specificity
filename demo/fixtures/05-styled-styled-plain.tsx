// A Linaria target with a plain link in its extends chain. The evaluated
// `__wyw_meta` chain stops at `Plain`, so upstream emits `.Outer.Inner`
// (0,2,0), which only ties with the inner rule `.Inner.Inner`. The static
// resolver follows the chain through the plain component.
import { styled } from '@linaria/react';

const Base = styled.div`
  background: red;
`;

const Plain = ({ className }: { className?: string }) => (
  <Base className={className} />
);

export const Inner = styled(Plain)`
  background: green;
`;

export const Outer = styled(Inner)`
  background: blue;
`;
