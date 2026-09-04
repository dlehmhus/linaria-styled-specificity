// Branches, a cx() mix, a variant map and a local: the tracer follows all of
// them and the deepest reachable chain wins (Deeper -> Base = depth 2).
import { css, cx } from '@linaria/core';
import { styled } from '@linaria/react';

const Base = styled.div`
  background: red;
`;

const Deeper = styled(Base)`
  padding: 1rem;
`;

const Flat = styled.span`
  color: black;
`;

const small = css`
  font-size: 0.75rem;
`;

const large = css`
  font-size: 1.25rem;
`;

const sizes = { small, large };

type Props = {
  className?: string;
  block?: boolean;
  size?: keyof typeof sizes;
};

export const Plain = ({ className, block, size = 'small' }: Props) => {
  const classes = cx(className, sizes[size]);
  const Root = block ? Deeper : Flat;
  return <Root className={classes} />;
};

export const Styled = styled(Plain)`
  background: blue;
`;
