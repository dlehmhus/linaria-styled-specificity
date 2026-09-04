// The tracer cannot prove where `className` ends up (string concatenation).
// The static processor refuses to guess and fails the build with the reason;
// upstream would emit a silently weak `.Styled`.
import { styled } from '@linaria/react';

const Base = styled.div`
  background: red;
`;

export const Plain = ({ className = '' }: { className?: string }) => (
  <Base className={className + ' extra'} />
);

export const Styled = styled(Plain)`
  background: blue;
`;
