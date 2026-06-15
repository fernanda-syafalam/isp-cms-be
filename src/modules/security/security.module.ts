import { Module } from '@nestjs/common';
import { SecurityController } from './security.controller';
import { SecurityRepository } from './security.repository';
import { SecurityService } from './security.service';

@Module({
  controllers: [SecurityController],
  providers: [SecurityService, SecurityRepository],
})
export class SecurityModule {}
