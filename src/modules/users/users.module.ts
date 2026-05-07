import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService, UsersRepository],
  // UsersRepository is exported so AuthModule's JwtStrategy can resolve
  // a user without going through UsersService — the service throws
  // NotFoundException for "missing user", and the auth path needs to
  // convert that to UnauthorizedException without crossing exception
  // boundaries twice. UsersService remains the canonical entry for
  // anything else.
  exports: [UsersService, UsersRepository],
})
export class UsersModule {}
