// The plain component renders a two-level Linaria chain. Doubling (the
// React.lazy treatment) would give `.Styled.Styled` (0,2,0) and only tie with
// `.Deeper.Base`; the static depth gives `.Styled.Styled.Styled`.
import { styled } from '@linaria/react';

const Base = styled.div`
  background: red;
`;

const Deeper = styled(Base)`
  padding: 1rem;
`;

export const Plain = ({ className }: { className?: string }) => (
  <Deeper className={className} />
);

export const Styled = styled(Plain)`
  background: blue;
`;
