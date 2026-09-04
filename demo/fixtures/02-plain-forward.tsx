// The core case: a plain React component forwards `className` to a Linaria
// root. Upstream emits `.Styled` (ties with `.Base`, stylesheet order decides);
// the static processor emits `.Styled.Styled`.
import { styled } from '@linaria/react';
import type { ReactNode } from 'react';

const Base = styled.div`
  background: red;
`;

type Props = { className?: string; children?: ReactNode };

export const Plain = ({ className, children }: Props) => (
  <Base className={className}>{children}</Base>
);

export const Styled = styled(Plain)`
  background: blue;
`;
