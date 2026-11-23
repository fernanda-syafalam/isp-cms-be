import { UseGuards, applyDecorators } from '@nestjs/common';
import { MvpDisabledGuard } from '../guards/mvp-disabled.guard';

// The UI for this route is hidden for the MVP, so it answers 404. The handler
// and service stay in place; remove this decorator to re-open the route.
export const MvpDisabled = () => applyDecorators(UseGuards(MvpDisabledGuard));
