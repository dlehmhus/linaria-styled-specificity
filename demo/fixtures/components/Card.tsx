// A typical component-library wrapper: adds props, forwards className to a
// styled root, supports `as`. Lives in its own file so the tracer has to
// follow the import.
import { styled } from '@linaria/react';
import type { ElementType, ReactNode } from 'react';

const Root = styled.article`
  border-radius: 0.5rem;
  background: white;
`;

type Props = {
  className?: string;
  as?: ElementType;
  elevated?: boolean;
  children?: ReactNode;
};

export const Card = ({ className, as, elevated, children }: Props) => (
  <Root as={as} className={className} data-elevated={elevated || undefined}>
    {children}
  </Root>
);
