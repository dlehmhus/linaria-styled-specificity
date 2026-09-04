// Baseline: wrapping a Linaria component. Upstream already emits the compound
// selector `.Styled.Base` here, so both processors agree.
import { styled } from '@linaria/react';

export const Base = styled.div`
  background: red;
`;

export const Styled = styled(Base)`
  background: blue;
`;
