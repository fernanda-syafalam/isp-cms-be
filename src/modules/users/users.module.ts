import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService, UsersRepository],
  // Only the service is exported. UsersRepository is an internal detail
  // — other modules must talk to users through the service. See Pilar 1.
  exports: [UsersService],
})
export class UsersModule {}
