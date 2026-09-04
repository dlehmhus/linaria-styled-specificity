// Nested compounds inside a template. `variant()` keeps the base specificity
// (a wrapper override wins), `state()` adds one ID (the state always wins).
// A bare `&.x` would tie with any wrapper and be decided by stylesheet order.
import { css } from '@linaria/core';
import { styled } from '@linaria/react';
import { state } from '../../helpers/state';
import { variant } from '../../helpers/variant';

export const image = css`
  width: 8rem;
  ${variant('.small')} {
    width: 4rem;
  }
  ${state('.img-error')} {
    background: grey;
  }
`;

export const Button = styled.button`
  padding: 0.5rem 1rem;
  ${variant('.primary')} {
    background: black;
    color: white;
  }
  ${state('.loading')} {
    pointer-events: none;
    opacity: 0.5;
  }
`;
